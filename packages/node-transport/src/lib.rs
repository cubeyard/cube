//! First real wire slice. No execution, environment allocation or public listener.
//! One bounded QUERY per bidirectional stream; no retries and no 0-RTT.
use std::{net::SocketAddr, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey, endpoint::presets};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::{io::AsyncRead, io::AsyncReadExt, task::JoinSet, time::timeout};

pub const ALPN: &[u8] = b"cubeyard/node/1";
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_CONNECTIONS: usize = 16;

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "method", deny_unknown_fields)]
pub enum Query {
    #[serde(rename = "node.hello")]
    Hello {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", deny_unknown_fields)]
pub enum Response {
    Hello {
        #[serde(rename = "nodeId")]
        node_id: String,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        profiles: Vec<String>,
        capabilities: Vec<String>,
        limits: Limits,
    },
    Error {
        code: String,
        message: String,
        #[serde(rename = "completionUnknown")]
        completion_unknown: bool,
    },
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Limits {
    pub max_frame_bytes: usize,
    pub request_timeout_ms: u64,
}

impl Response {
    fn error(code: &str, message: &str) -> Self {
        Self::Error {
            code: code.into(),
            message: message.into(),
            completion_unknown: false,
        }
    }
}

/// No DNS discovery, relay, port mapping or non-loopback socket. External node
/// connectivity must be added explicitly, with its own acceptance evidence.
pub async fn bind_loopback(key: SecretKey, listen: SocketAddr) -> Result<Endpoint> {
    ensure!(
        listen.ip().is_loopback(),
        "bootstrap listener must be loopback"
    );
    Ok(Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .alpns(vec![ALPN.to_vec()])
        .clear_ip_transports()
        .clear_relay_transports()
        .clear_address_lookup()
        .bind_addr(listen)?
        .bind()
        .await?)
}

pub fn validate_node_id(node_id: &str) -> Result<()> {
    ensure!(
        node_id.starts_with("node-")
            && (6..=128).contains(&node_id.len())
            && node_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-'),
        "invalid logical node ID"
    );
    Ok(())
}

/// u32 big-endian payload length followed by exactly that many UTF-8 JSON bytes,
/// then stream FIN. FIN is mandatory: this version does not allow pipelining.
pub fn encode<T: Serialize>(value: &T) -> Result<Vec<u8>> {
    let payload = serde_json::to_vec(value)?;
    ensure!(payload.len() <= MAX_FRAME_BYTES, "frame exceeds limit");
    let mut bytes = Vec::with_capacity(4 + payload.len());
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&payload);
    Ok(bytes)
}

pub async fn read_frame<T: DeserializeOwned>(reader: &mut (impl AsyncRead + Unpin)) -> Result<T> {
    let size = reader.read_u32().await? as usize;
    ensure!(size > 0 && size <= MAX_FRAME_BYTES, "invalid frame length");
    let mut payload = vec![0; size];
    reader.read_exact(&mut payload).await?;
    let mut trailing = [0u8; 1];
    ensure!(
        reader.read(&mut trailing).await? == 0,
        "trailing frame bytes"
    );
    Ok(serde_json::from_slice(&payload)?)
}

fn hello(node_id: &str, query: Query) -> Response {
    match query {
        Query::Hello {
            protocol_version: 1,
        } => Response::Hello {
            node_id: node_id.into(),
            protocol_version: 1,
            // Do not advertise a host executor before it exists.
            profiles: vec![],
            capabilities: vec!["node.hello".into()],
            limits: Limits {
                max_frame_bytes: MAX_FRAME_BYTES,
                request_timeout_ms: REQUEST_TIMEOUT.as_millis() as u64,
            },
        },
        _ => Response::error("UNSUPPORTED", "unsupported protocol version"),
    }
}

/// The caller enrolls a peer key outside the wire protocol. Authenticate the
/// QUIC peer before reading any application data, including hello/nodeId.
async fn accept(
    incoming: iroh::endpoint::Incoming,
    allowed_peer: EndpointId,
    node_id: String,
) -> Result<()> {
    let connection = incoming.await?;
    if connection.remote_id() != allowed_peer {
        connection.close(1u32.into(), b"UNAUTHORIZED");
        bail!("unauthorized peer");
    }
    let (mut send, mut recv) = connection.accept_bi().await?;
    let response = match read_frame::<Query>(&mut recv).await {
        Ok(query) => hello(&node_id, query),
        Err(_) => Response::error("INVALID_REQUEST", "invalid request frame"),
    };
    send.write_all(&encode(&response)?).await?;
    send.finish()?;
    // Keep the connection alive until the caller consumes the response. The
    // enclosing deadline also bounds callers that never close the connection.
    connection.closed().await;
    Ok(())
}

/// Bounded handshakes and requests. Dropping this future aborts its owned tasks;
/// callers must also close the endpoint. Per-peer failures never stop the server.
pub async fn serve(endpoint: &Endpoint, allowed_peer: EndpointId, node_id: &str) -> Result<()> {
    validate_node_id(node_id)?;
    let mut tasks = JoinSet::new();
    loop {
        tokio::select! {
            incoming = endpoint.accept() => {
                let Some(incoming) = incoming else { break };
                if tasks.len() >= MAX_CONNECTIONS {
                    incoming.refuse();
                    continue;
                }
                let node_id = node_id.to_owned();
                tasks.spawn(async move {
                    timeout(REQUEST_TIMEOUT, accept(incoming, allowed_peer, node_id)).await
                });
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}

/// `address.id` is the pinned, enrolled server peer key, not an unauthenticated
/// value learned from hello. Expected logical identity is checked separately.
/// This read-only probe never retries; it does not allocate or wake an environment.
pub async fn query_hello(
    endpoint: &Endpoint,
    address: EndpointAddr,
    expected_node_id: &str,
) -> Result<Response> {
    validate_node_id(expected_node_id)?;
    timeout(REQUEST_TIMEOUT, async {
        let connection = endpoint.connect(address, ALPN).await?;
        let result = async {
            let (mut send, mut recv) = connection.open_bi().await?;
            send.write_all(&encode(&Query::Hello {
                protocol_version: 1,
            })?)
            .await?;
            send.finish()?;
            let response: Response = read_frame(&mut recv).await?;
            match &response {
                Response::Hello {
                    node_id,
                    protocol_version: 1,
                    ..
                } if node_id == expected_node_id => Ok(response),
                Response::Hello { .. } => {
                    bail!("WRONG_NODE: unexpected logical identity or version")
                }
                Response::Error { code, .. } => bail!("node rejected hello: {code}"),
            }
        }
        .await;
        connection.close(0u32.into(), b"query complete");
        result
    })
    .await
    .context("node hello timed out")?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn strict_bounded_frames() {
        let bytes = encode(&Query::Hello {
            protocol_version: 1,
        })
        .unwrap();
        assert!(read_frame::<Query>(&mut bytes.as_slice()).await.is_ok());
        for bytes in [
            vec![],
            vec![0, 0, 0, 0],
            vec![255; 4],
            vec![0, 0, 0, 2, b'{'],
        ] {
            assert!(read_frame::<Query>(&mut bytes.as_slice()).await.is_err());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(read_frame::<Query>(&mut trailing.as_slice()).await.is_err());
        for value in [
            serde_json::json!({"method":"exec.start"}),
            serde_json::json!({"method":"node.hello", "protocolVersion":1, "nodeId":"spoof"}),
            serde_json::json!({"method":"node.hello", "protocolVersion":-1}),
        ] {
            assert!(
                read_frame::<Query>(&mut encode(&value).unwrap().as_slice())
                    .await
                    .is_err()
            );
        }
        assert!(encode(&"x".repeat(MAX_FRAME_BYTES)).is_err());
    }

    #[test]
    fn version_and_identity_validation() {
        assert!(
            matches!(hello("node-test", Query::Hello { protocol_version: 2 }), Response::Error { code, .. } if code == "UNSUPPORTED")
        );
        for id in ["", "node-", "other-node", "node-../etc", "node-é"] {
            assert!(validate_node_id(id).is_err());
        }
    }

    #[tokio::test]
    async fn rejects_public_listener() {
        assert!(
            bind_loopback(SecretKey::generate(), "0.0.0.0:0".parse().unwrap())
                .await
                .is_err()
        );
    }
}
