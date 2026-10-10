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
