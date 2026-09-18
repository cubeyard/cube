//! Authenticated node protocol (loopback by default); optional trusted runner execution.
//! Bounded frames, no retries, no 0-RTT; commands outlive their connection.
pub mod intent;
pub mod runner;
use std::{net::SocketAddr, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey, endpoint::presets};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::{io::AsyncRead, io::AsyncReadExt, task::JoinSet, time::timeout};

pub const ALPN: &[u8] = b"cubeyard/node/1";
pub const PROTOCOL_VERSION: u32 = 1;
pub const MIN_COMPATIBLE_PROTOCOL_VERSION: u32 = 1;
pub const SOFTWARE_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
pub const RELAY_READY_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CONNECTIONS: usize = 16;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "method", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "node.hello")]
    Hello {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    #[serde(rename = "environment.inspect")]
    Inspect { env: u64 },
    #[serde(rename = "workspace.allocate")]
    WorkspaceAllocate {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        repository: Option<runner::RepositorySource>,
    },
    #[serde(rename = "workspace.release")]
    WorkspaceRelease {
        #[serde(rename = "threadId")]
        thread_id: String,
    },
    #[serde(rename = "node.status")]
    Status,
    #[serde(rename = "exec.start")]
    ExecStart {
        #[serde(rename = "operationId")]
        operation_id: String,
        env: u64,
        #[serde(rename = "threadId", default, skip_serializing_if = "Option::is_none")]
        thread_id: Option<String>,
        spec: runner::ExecSpec,
    },
    #[serde(rename = "operation.get")]
    OperationGet {
        env: u64,
        #[serde(rename = "operationId")]
        operation_id: String,
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
        #[serde(rename = "minimumProtocolVersion")]
        minimum_protocol_version: u32,
        #[serde(rename = "softwareVersion")]
        software_version: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        binding: Option<runner::Binding>,
    },
    Status {
        #[serde(rename = "nodeId")]
        node_id: String,
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
        #[serde(rename = "minimumProtocolVersion")]
        minimum_protocol_version: u32,
        #[serde(rename = "softwareVersion")]
        software_version: String,
        binding: runner::Binding,
        status: runner::RunnerStatus,
    },
    Accepted {
        #[serde(rename = "operationId")]
        operation_id: String,
    },
    Operation {
        #[serde(rename = "operationId")]
        operation_id: String,
        operation: runner::Operation,
    },
    Environment {
        binding: runner::Binding,
        state: String,
    },
    Workspace {
        workspace: runner::WorkspaceStatus,
    },
    Error {
        code: String,
        message: String,
        #[serde(rename = "completionUnknown")]
        completion_unknown: bool,
        #[serde(
            rename = "operationId",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        operation_id: Option<String>,
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
            operation_id: None,
        }
    }
}

/// Loopback and direct modes have no external dependencies. Relay mode uses
/// Iroh's N0 discovery and relay preset and must be explicitly selected.
#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum NetworkMode {
    #[default]
    Loopback,
    Direct,
    Relay,
}

fn unicast(address: SocketAddr) -> bool {
    let ip = address.ip().to_canonical();
    !ip.is_unspecified()
        && !ip.is_multicast()
        && !matches!(ip, std::net::IpAddr::V4(ip) if ip.is_broadcast())
}
pub fn validate_target(address: SocketAddr, mode: NetworkMode) -> Result<()> {
    ensure!(
        mode != NetworkMode::Relay,
        "relay mode does not take a target address"
    );
    ensure!(
        unicast(address) && address.port() != 0,
        "target must be a concrete unicast address and port"
    );
    ensure!(
        mode == NetworkMode::Direct || address.ip().to_canonical().is_loopback(),
        "non-loopback target requires explicit direct mode"
    );
    Ok(())
}
async fn bind_transport(key: SecretKey, listen: SocketAddr) -> Result<Endpoint> {
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
async fn bind_relay_transport(key: SecretKey, alpns: Vec<Vec<u8>>) -> Result<Endpoint> {
    let endpoint = Endpoint::builder(presets::N0)
        .secret_key(key)
        .alpns(alpns)
        .bind()
        .await?;
    timeout(RELAY_READY_TIMEOUT, endpoint.online())
        .await
        .context("timed out connecting to an N0 relay")?;
    Ok(endpoint)
}
pub async fn bind_relay_node(key: SecretKey) -> Result<Endpoint> {
    bind_relay_transport(key, vec![ALPN.to_vec()]).await
}
pub async fn bind_relay_client(key: SecretKey) -> Result<Endpoint> {
    bind_relay_transport(key, vec![]).await
}
pub async fn bind_node(key: SecretKey, listen: SocketAddr, mode: NetworkMode) -> Result<Endpoint> {
    ensure!(
        mode != NetworkMode::Relay,
        "relay mode does not take a listener address"
    );
    ensure!(
        unicast(listen),
        "listener must select a concrete unicast interface, not a wildcard"
    );
    ensure!(
        mode == NetworkMode::Direct || listen.ip().to_canonical().is_loopback(),
        "non-loopback listener requires explicit direct mode"
    );
    bind_transport(key, listen).await
}
pub async fn bind_loopback(key: SecretKey, listen: SocketAddr) -> Result<Endpoint> {
    bind_node(key, listen, NetworkMode::Loopback).await
}
pub async fn bind_client(
    key: SecretKey,
    target: SocketAddr,
    mode: NetworkMode,
) -> Result<Endpoint> {
    validate_target(target, mode)?;
    let local = match (mode, target.is_ipv6()) {
        (NetworkMode::Loopback, false) => "127.0.0.1:0",
        (NetworkMode::Loopback, true) => "[::1]:0",
        (NetworkMode::Direct, false) => "0.0.0.0:0",
        (NetworkMode::Direct, true) => "[::]:0",
        (NetworkMode::Relay, _) => bail!("relay mode requires a relay endpoint address"),
    };
    // A direct caller needs routing-selected local source addresses. There is
    // no application accept loop on this ephemeral client endpoint.
    bind_transport(key, local.parse()?).await
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

fn hello(node_id: &str, query: Request) -> Response {
    match query {
        Request::Hello {
            protocol_version: PROTOCOL_VERSION,
        } => Response::Hello {
            node_id: node_id.into(),
            protocol_version: 1,
            // The plain serve probe never enables trusted-runner execution.
            profiles: vec![],
            capabilities: vec!["node.hello".into()],
            limits: Limits {
                max_frame_bytes: MAX_FRAME_BYTES,
                request_timeout_ms: REQUEST_TIMEOUT.as_millis() as u64,
            },
            minimum_protocol_version: MIN_COMPATIBLE_PROTOCOL_VERSION,
            software_version: SOFTWARE_VERSION.into(),
            binding: None,
        },
        _ => Response::error(
            "INCOMPATIBLE_PROTOCOL",
            "protocol version 1 required; upgrade cubed or cube-runner",
        ),
    }
}

fn dispatch(node_id: &str, query: Request, runner: Option<&Arc<runner::Runner>>) -> Response {
    if matches!(query, Request::Hello { .. }) {
        let mut result = hello(node_id, query);
        if let Some(runner) = runner
            && let Response::Hello {
                profiles,
                capabilities,
                binding,
                ..
            } = &mut result
        {
            *binding = Some(runner.installation().binding.clone());
            // `host` is the protocol-v1 compatibility profile. New peers use
            // `runner`; both names describe the same immutable binding.
            *profiles = vec!["runner".into(), "host".into()];
            capabilities.extend(
                [
                    "node.status",
                    "environment.inspect",
                    "workspace.allocate",
                    "workspace.fresh-base",
                    "workspace.release",
                    "exec.start",
                    "operation.get",
                ]
                .map(String::from),
            );
        }
        return result;
    }
    let Some(runner) = runner else {
        return Response::error("UNSUPPORTED", "runner execution is not enabled");
    };
    let operation_id = match &query {
        Request::ExecStart { operation_id, .. } | Request::OperationGet { operation_id, .. } => {
            Some(operation_id.clone())
        }
        _ => None,
    }
    .filter(|id| runner::valid_id(id));
    let mutation = matches!(
        query,
        Request::ExecStart { .. }
            | Request::WorkspaceAllocate { .. }
            | Request::WorkspaceRelease { .. }
    );
    let result = match query {
        Request::Status => runner.status().map(|status| Response::Status {
            node_id: node_id.into(),
            protocol_version: PROTOCOL_VERSION,
            minimum_protocol_version: MIN_COMPATIBLE_PROTOCOL_VERSION,
            software_version: SOFTWARE_VERSION.into(),
            binding: runner.installation().binding.clone(),
            status,
        }),
        Request::Inspect { env } => runner
            .inspect(env)
            .map(|installation| Response::Environment {
                binding: installation.binding.clone(),
                state: "ready".into(),
            }),
        Request::WorkspaceAllocate {
            thread_id,
            repository,
        } => runner
            .allocate(&thread_id, repository.as_ref())
            .map(|workspace| Response::Workspace { workspace }),
        Request::WorkspaceRelease { thread_id } => runner
            .release(&thread_id)
            .map(|workspace| Response::Workspace { workspace }),
        Request::ExecStart {
            env,
            operation_id,
            thread_id,
            spec,
        } => runner
            .start_in_workspace(env, thread_id.as_deref(), &operation_id, spec)
            .map(|()| Response::Accepted { operation_id }),
        Request::OperationGet { env, operation_id } => {
            runner
                .get(env, &operation_id)
                .map(|operation| Response::Operation {
                    operation_id,
                    operation,
                })
        }
        Request::Hello { .. } => unreachable!(),
    };
    result.unwrap_or_else(|error| {
        if let Some(error) = error.downcast_ref::<runner::RunnerError>() {
            Response::Error {
                code: error.0.into(),
                message: "runner request rejected".into(),
                completion_unknown: false,
                operation_id: operation_id.clone(),
            }
        } else if let Some(error) = error.downcast_ref::<runner::RunnerErrorDetail>() {
            Response::Error {
                code: error.0.into(),
                message: error.1.clone(),
                completion_unknown: false,
                operation_id: operation_id.clone(),
            }
        } else {
            // A journal commit may have happened. Do not assert no side effects.
            Response::Error {
                code: "IO_ERROR".into(),
                message: "runner state could not be confirmed".into(),
                completion_unknown: mutation,
                operation_id,
            }
        }
    })
}

/// Authenticate before application data. A successful hello is required on
/// this SAME connection before any environment operation. Each connection gets
/// at most two streams: hello and one request; the client never retries.
async fn accept(
    incoming: iroh::endpoint::Incoming,
    allowed_peer: EndpointId,
    node_id: String,
    runner: Option<Arc<runner::Runner>>,
) -> Result<()> {
    let connection = incoming.await?;
    if connection.remote_id() != allowed_peer {
        connection.close(1u32.into(), b"UNAUTHORIZED");
        bail!("unauthorized peer");
    }
    let mut negotiated = false;
    for _ in 0..2 {
        let (mut send, mut recv) = connection.accept_bi().await?;
        let response = match read_frame::<Request>(&mut recv).await {
            Ok(query) => {
                if !negotiated && !matches!(query, Request::Hello { .. }) {
                    Response::error("INVALID_REQUEST", "hello required before environment work")
                } else {
                    let response = dispatch(&node_id, query, runner.as_ref());
                    if matches!(
                        response,
                        Response::Hello {
                            protocol_version: PROTOCOL_VERSION,
                            ..
                        }
                    ) {
                        negotiated = true;
                    }
                    response
                }
            }
            Err(_) => Response::error("INVALID_REQUEST", "invalid request frame"),
        };
        send.write_all(&encode(&response)?).await?;
        send.finish()?;
        if !negotiated {
            break;
        }
    }
    connection.closed().await;
    Ok(())
}

pub async fn serve(endpoint: &Endpoint, allowed_peer: EndpointId, node_id: &str) -> Result<()> {
    serve_runner(endpoint, allowed_peer, node_id, None).await
}

/// Dropping connection tasks does not drop accepted runner jobs. Graceful daemon
/// shutdown closes the endpoint then waits through Runner::shutdown().
pub async fn serve_runner(
    endpoint: &Endpoint,
    allowed_peer: EndpointId,
    node_id: &str,
    runner: Option<Arc<runner::Runner>>,
) -> Result<()> {
    validate_node_id(node_id)?;
    if let Some(runner) = &runner {
        ensure!(
            runner.installation().binding.node_id == node_id
                && runner.installation().allowed_peer == allowed_peer.to_string()
                && runner.installation().peer_id == endpoint.id().to_string(),
            "WRONG_NODE: runner installation mismatch"
        );
    }
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
                let runner = runner.clone();
                tasks.spawn(async move {
                    timeout(REQUEST_TIMEOUT, accept(incoming, allowed_peer, node_id, runner)).await
                });
            }
            Some(_) = tasks.join_next(), if !tasks.is_empty() => {}
        }
    }
    tasks.abort_all();
    while tasks.join_next().await.is_some() {}
    Ok(())
}

#[derive(Debug)]
pub struct DeliveryError {
    pub code: &'static str,
    pub completion_unknown: bool,
    pub operation_id: Option<String>,
}
impl std::fmt::Display for DeliveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: operation={:?}; completionUnknown={}",
            self.code, self.operation_id, self.completion_unknown
        )
    }
}
impl std::error::Error for DeliveryError {}

/// Call exactly once, negotiating identity on the same connection before work.
/// COMMAND callers must persist intent before calling; after possible delivery,
/// reconcile operation.get, never invoke the command automatically again.
pub async fn call(
    endpoint: &Endpoint,
    address: EndpointAddr,
    expected_node_id: &str,
    query: &Request,
) -> Result<Response> {
    call_inner(endpoint, address, expected_node_id, None, query).await
}

pub async fn call_bound(
    endpoint: &Endpoint,
    address: EndpointAddr,
    binding: &runner::Binding,
    query: &Request,
) -> Result<Response> {
    call_inner(endpoint, address, &binding.node_id, Some(binding), query).await
}

async fn call_inner(
    endpoint: &Endpoint,
    address: EndpointAddr,
    expected_node_id: &str,
    expected_binding: Option<&runner::Binding>,
    query: &Request,
) -> Result<Response> {
    validate_node_id(expected_node_id)?;
    ensure!(
        !matches!(query, Request::Hello { .. }),
        "use query_hello for contact probes"
    );
    let bytes = encode(query)?;
    let operation_id = match query {
        Request::ExecStart { operation_id, .. } => Some(operation_id.clone()),
        _ => None,
    };
    let mut possible_delivery = false;
    let mut connection_to_close = None;
    let result = timeout(REQUEST_TIMEOUT, async {
        let connection = endpoint.connect(address, ALPN).await?;
        connection_to_close = Some(connection.clone());
        let (mut send, mut recv) = connection.open_bi().await?;
        send.write_all(&encode(&Request::Hello {
            protocol_version: PROTOCOL_VERSION,
        })?)
        .await?;
        send.finish()?;
        match read_frame::<Response>(&mut recv).await? {
            Response::Hello {
                node_id,
                protocol_version: PROTOCOL_VERSION,
                minimum_protocol_version: MIN_COMPATIBLE_PROTOCOL_VERSION,
                binding,
                ..
            } if node_id == expected_node_id
                && expected_binding.is_none_or(|expected| binding.as_ref() == Some(expected)) => {}
            _ => {
                return Err(DeliveryError {
                    code: "WRONG_NODE",
                    completion_unknown: false,
                    operation_id: operation_id.clone(),
                }
                .into());
            }
        }
        let (mut send, mut recv) = connection.open_bi().await?;
        possible_delivery = operation_id.is_some();
        send.write_all(&bytes).await?;
        send.finish()?;
        let response: Response = read_frame(&mut recv).await?;
        match (&response, query) {
            (Response::Accepted { operation_id: got }, Request::ExecStart { operation_id, .. })
                if got == operation_id => {}
            (
                Response::Operation {
                    operation_id: got, ..
                },
                Request::OperationGet { operation_id, .. },
            ) if got == operation_id => {}
            (Response::Environment { binding, .. }, Request::Inspect { env })
                if binding.environment_id == *env && binding.node_id == expected_node_id => {}
            (
                Response::Status {
                    node_id,
                    protocol_version: PROTOCOL_VERSION,
                    minimum_protocol_version: MIN_COMPATIBLE_PROTOCOL_VERSION,
                    ..
                },
                Request::Status,
            ) if node_id == expected_node_id => {}
            (Response::Error { .. }, _) => {}
            _ => bail!("invalid response for request"),
        }
        Ok::<_, anyhow::Error>(response)
    })
    .await;
    if let Some(connection) = connection_to_close {
        connection.close(0u32.into(), b"request complete");
    }
    match result {
        Ok(Ok(response)) => Ok(response),
        Ok(Err(error)) if error.is::<DeliveryError>() => Err(error),
        _ => Err(DeliveryError {
            code: if possible_delivery {
                "OUTCOME_UNKNOWN"
            } else {
                "NODE_UNAVAILABLE"
            },
            completion_unknown: possible_delivery,
            operation_id,
        }
        .into()),
    }
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
            send.write_all(&encode(&Request::Hello {
                protocol_version: PROTOCOL_VERSION,
            })?)
            .await?;
            send.finish()?;
            let response: Response = read_frame(&mut recv).await?;
            match &response {
                Response::Hello {
                    node_id,
                    protocol_version: PROTOCOL_VERSION,
                    minimum_protocol_version: MIN_COMPATIBLE_PROTOCOL_VERSION,
                    ..
                } if node_id == expected_node_id => Ok(response),
                Response::Hello { .. } => {
                    bail!("WRONG_NODE: unexpected logical identity or version")
                }
                Response::Error { code, .. } => bail!("node rejected hello: {code}"),
                _ => bail!("invalid hello response"),
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
        let bytes = encode(&Request::Hello {
            protocol_version: PROTOCOL_VERSION,
        })
        .unwrap();
        assert!(read_frame::<Request>(&mut bytes.as_slice()).await.is_ok());
        for bytes in [
            vec![],
            vec![0, 0, 0, 0],
            vec![255; 4],
            vec![0, 0, 0, 2, b'{'],
        ] {
            assert!(read_frame::<Request>(&mut bytes.as_slice()).await.is_err());
        }
        let mut trailing = bytes.clone();
        trailing.push(0);
        assert!(
            read_frame::<Request>(&mut trailing.as_slice())
                .await
                .is_err()
        );
        for value in [
            serde_json::json!({"method":"exec.start"}),
            serde_json::json!({"method":"node.hello", "protocolVersion":1, "nodeId":"spoof"}),
            serde_json::json!({"method":"node.hello", "protocolVersion":-1}),
        ] {
            assert!(
                read_frame::<Request>(&mut encode(&value).unwrap().as_slice())
                    .await
                    .is_err()
            );
        }
        assert!(encode(&"x".repeat(MAX_FRAME_BYTES)).is_err());
    }

    #[test]
    fn version_and_identity_validation() {
        assert!(
            matches!(hello("node-test", Request::Hello { protocol_version: 2 }), Response::Error { code, .. } if code == "INCOMPATIBLE_PROTOCOL")
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
