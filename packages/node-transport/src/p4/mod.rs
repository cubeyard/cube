//! Runner protocol 4 (`cubeyard/runner/4`): the types of proto/runner.proto.
pub mod proto {
    #![allow(clippy::all, clippy::pedantic, missing_docs)]
    include!(concat!(env!("OUT_DIR"), "/cube.runner.v4.rs"));
    include!(concat!(env!("OUT_DIR"), "/cube.runner.v4.serde.rs"));
}

use chrono::{DateTime, SecondsFormat, Utc};
use serde::{Deserialize, Deserializer, Serialize, Serializer, de::Error as _};

/// `google.protobuf.Timestamp` in its proto3 JSON form (RFC 3339 in UTC
/// with `Z`, 0, 3, 6 or 9 fractional digits).
#[derive(Clone, Copy, PartialEq, Eq, Hash, ::prost::Message)]
pub struct Timestamp {
    #[prost(int64, tag = "1")]
    pub seconds: i64,
    #[prost(int32, tag = "2")]
    pub nanos: i32,
}

impl Timestamp {
    pub fn now() -> Self {
        Self::from(std::time::SystemTime::now())
    }
}

impl From<std::time::SystemTime> for Timestamp {
    fn from(time: std::time::SystemTime) -> Self {
        let since = time
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default();
        Self {
            seconds: since.as_secs() as i64,
            nanos: since.subsec_nanos() as i32,
        }
    }
}

impl Serialize for Timestamp {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let time = DateTime::<Utc>::from_timestamp(self.seconds, self.nanos as u32)
            .ok_or_else(|| serde::ser::Error::custom("timestamp out of range"))?;
        serializer.serialize_str(&time.to_rfc3339_opts(SecondsFormat::AutoSi, true))
    }
}

impl<'de> Deserialize<'de> for Timestamp {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let text = String::deserialize(deserializer)?;
        let time = DateTime::parse_from_rfc3339(&text).map_err(D::Error::custom)?;
        Ok(Self {
            seconds: time.timestamp(),
            nanos: time.timestamp_subsec_nanos() as i32,
        })
    }
}

pub mod host;

use anyhow::{Result, ensure};
use iroh::{Endpoint, EndpointId};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    task::JoinSet,
    time::timeout,
};

pub const ALPN: &[u8] = b"cubeyard/runner/4";
pub const PROTOCOL: u32 = 4;
/// A header frame (`Open`, an answer, a watch event).
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
const MAX_CONNECTIONS: usize = 16;

pub fn refuse(code: proto::Code, reason: &str, message: &str) -> proto::Error {
    proto::Error {
        code: code as i32,
        reason: reason.into(),
        message: message.chars().take(1024).collect(),
        completion_unknown: false,
    }
}

/// u32 big-endian length, then that many bytes of proto3 JSON.
pub async fn write_frame<T: Serialize>(
    send: &mut iroh::endpoint::SendStream,
    value: &T,
) -> Result<()> {
    let payload = serde_json::to_vec(value)?;
    ensure!(payload.len() <= MAX_FRAME_BYTES, "frame exceeds limit");
    let mut bytes = Vec::with_capacity(4 + payload.len());
    bytes.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend_from_slice(&payload);
    send.write_all(&bytes).await?;
    Ok(())
}

pub async fn read_frame<T: serde::de::DeserializeOwned>(
    recv: &mut (impl AsyncRead + Unpin),
) -> Result<T> {
    let size = recv.read_u32().await? as usize;
    ensure!(size > 0 && size <= MAX_FRAME_BYTES, "invalid frame length");
    let mut payload = vec![0; size];
    recv.read_exact(&mut payload).await?;
    Ok(serde_json::from_slice(&payload)?)
}

/// Accepts protocol-4 connections from `allowed` only; each stream is one
/// call (see proto/runner.proto).
pub async fn serve_host(
    endpoint: &Endpoint,
    allowed: EndpointId,
    runner: std::sync::Arc<host::HostRunner>,
) -> Result<()> {
    runner.probe_all();
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            incoming = endpoint.accept() => {
                let Some(incoming) = incoming else { break };
                if connections.len() >= MAX_CONNECTIONS {
                    incoming.refuse();
                    continue;
                }
                let runner = runner.clone();
                connections.spawn(async move {
                    let Ok(Ok(connection)) = timeout(crate::REQUEST_TIMEOUT, incoming).await else { return };
                    if connection.remote_id() != allowed || connection.alpn() != ALPN {
                        connection.close(1u32.into(), b"UNAUTHORIZED");
                        return;
                    }
                    host::serve_connection(runner, connection).await;
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    Ok(())
}
