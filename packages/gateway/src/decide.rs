//! Client for cubed's decision API: `POST /v1/decide` on `egress.sock`, once
//! per guest HTTP request. No answer within the timeout, a socket error or a
//! malformed answer is a deny.
use anyhow::{Context, Result, bail, ensure};
use bytes::Bytes;
use http_body_util::{BodyExt, Full, Limited};
use hyper::client::conn::http1::SendRequest;
use hyper_util::rt::TokioIo;
use serde::Serialize;
use std::{collections::HashMap, path::PathBuf, sync::Mutex, time::Duration};
use tokio::net::UnixStream;

pub const DECIDE_TIMEOUT: Duration = Duration::from_secs(5);
const POOL: usize = 8;
const MAX_ANSWER: usize = 64 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DecideRequest {
    pub vm_id: String,
    pub thread_id: String,
    pub scheme: &'static str,
    pub method: String,
    pub host: String,
    pub port: u16,
    pub path: String,
    pub placeholders: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Decision {
    Allow { substitute: HashMap<String, String> },
    Deny { reason: String },
}

impl Decision {
    fn deny(reason: impl Into<String>) -> Self {
        Self::Deny {
            reason: reason.into(),
        }
    }
}

pub struct DecideClient {
    socket: PathBuf,
    timeout: Duration,
    pool: Mutex<Vec<SendRequest<Full<Bytes>>>>,
}

impl DecideClient {
    pub fn new(socket: PathBuf, timeout: Duration) -> Self {
        Self {
            socket,
            timeout,
            pool: Mutex::new(vec![]),
        }
    }

    pub async fn decide(&self, request: &DecideRequest) -> Decision {
        match tokio::time::timeout(self.timeout, self.call(request)).await {
            Ok(Ok(decision)) => decision,
            Ok(Err(error)) => {
                eprintln!("cube-gateway: decision failed: {error:#}");
                Decision::deny("policy decision unavailable")
            }
            Err(_) => {
                eprintln!("cube-gateway: decision timed out");
                Decision::deny("policy decision timed out")
            }
        }
    }

    async fn sender(&self) -> Result<SendRequest<Full<Bytes>>> {
        loop {
            let Some(mut sender) = self.pool.lock().unwrap().pop() else {
                break;
            };
            if sender.ready().await.is_ok() {
                return Ok(sender);
            }
        }
        let stream = UnixStream::connect(&self.socket)
            .await
            .with_context(|| format!("connect {}", self.socket.display()))?;
        let (sender, connection) =
            hyper::client::conn::http1::handshake(TokioIo::new(stream)).await?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(sender)
    }

    async fn call(&self, request: &DecideRequest) -> Result<Decision> {
        let mut sender = self.sender().await?;
        let body = serde_json::to_vec(request)?;
        let http_request = http::Request::post("/v1/decide")
            .header(http::header::HOST, "cubed")
            .header(http::header::CONTENT_TYPE, "application/json")
            .body(Full::new(Bytes::from(body)))?;
        let response = sender.send_request(http_request).await?;
        let status = response.status();
        let body = Limited::new(response.into_body(), MAX_ANSWER)
            .collect()
            .await
            .map_err(|e| anyhow::anyhow!("read decision: {e}"))?
            .to_bytes();
        {
            let mut pool = self.pool.lock().unwrap();
            if pool.len() < POOL {
                pool.push(sender);
            }
        }
        ensure!(status == http::StatusCode::OK, "decision status {status}");
        parse(&body)
    }
}

/// `{"allow":true,"substitute":{…}}` or `{"allow":false,"reason":"…"}`.
pub fn parse(body: &[u8]) -> Result<Decision> {
    let value: serde_json::Value = serde_json::from_slice(body).context("decision is not JSON")?;
    let Some(allow) = value.get("allow").and_then(|a| a.as_bool()) else {
        bail!("decision lacks allow");
    };
    if !allow {
        let reason = value
            .get("reason")
            .and_then(|r| r.as_str())
            .filter(|r| !r.is_empty())
            .unwrap_or("denied by policy");
        return Ok(Decision::deny(reason));
    }
    let mut substitute = HashMap::new();
    match value.get("substitute") {
        None | Some(serde_json::Value::Null) => {}
        Some(serde_json::Value::Object(map)) => {
            for (key, value) in map {
                let Some(value) = value.as_str() else {
                    bail!("substitute values must be strings");
                };
                substitute.insert(key.clone(), value.to_string());
            }
        }
        Some(_) => bail!("substitute must be an object"),
    }
    Ok(Decision::Allow { substitute })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_parse_strictly() {
        assert_eq!(
            parse(br#"{"allow":true}"#).unwrap(),
            Decision::Allow {
                substitute: HashMap::new()
            }
        );
        assert_eq!(
            parse(br#"{"allow":true,"substitute":{"a":"b"}}"#).unwrap(),
            Decision::Allow {
                substitute: HashMap::from([("a".into(), "b".into())])
            }
        );
        assert_eq!(
            parse(br#"{"allow":false,"reason":"no"}"#).unwrap(),
            Decision::deny("no")
        );
        assert_eq!(
            parse(br#"{"allow":false}"#).unwrap(),
            Decision::deny("denied by policy")
        );
        assert!(parse(br#"{"allow":"yes"}"#).is_err());
        assert!(parse(br#"{"allow":true,"substitute":{"a":1}}"#).is_err());
        assert!(parse(br#"{"allow":true,"substitute":[]}"#).is_err());
        assert!(parse(b"nope").is_err());
    }
}
