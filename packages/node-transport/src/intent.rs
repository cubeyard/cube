//! Durable caller intent for the development CLI. A consumed marker prevents
//! automatic resubmission even when a response was lost or the CLI crashed.
use crate::{MAX_FRAME_BYTES, runner::ExecSpec, validate_node_id};
use anyhow::{Result, ensure};
use iroh::EndpointId;
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
};

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Intent {
    pub operation_id: String,
    pub node_id: String,
    pub environment_id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub thread_id: Option<String>,
    pub server_peer: String,
    pub control_peer: String,
    pub spec: ExecSpec,
}
impl Intent {
    pub fn prepare(
        path: &Path,
        node_id: String,
        environment_id: u64,
        server_peer: EndpointId,
        control_peer: EndpointId,
        spec: ExecSpec,
    ) -> Result<Self> {
        let intent = Self {
            operation_id: format!("op-{}", uuid::Uuid::new_v4()),
            node_id,
            environment_id,
            thread_id: None,
            server_peer: server_peer.to_string(),
            control_peer: control_peer.to_string(),
            spec,
        };
        intent.validate()?;
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(path)?;
        file.write_all(&serde_json::to_vec(&intent)?)?;
        file.sync_all()?;
        sync_parent(path)?;
        Ok(intent)
    }
    fn validate(&self) -> Result<()> {
        validate_node_id(&self.node_id)?;
        ensure!(
            crate::runner::valid_id(&self.operation_id),
            "invalid operation ID"
        );
        ensure!(
            (1..=9_007_199_254_740_991).contains(&self.environment_id),
            "invalid environment ID"
        );
        ensure!(
            self.thread_id
                .as_ref()
                .is_none_or(|id| crate::runner::valid_id(id)),
            "invalid intent thread ID"
        );
        self.server_peer.parse::<EndpointId>()?;
        self.control_peer.parse::<EndpointId>()?;
        self.spec.validate()
    }
    /// The request is immutable; submission state is a separate create-only
    /// marker. Never truncate/rewrite intent and risk losing its operation ID.
    pub fn load(path: &Path) -> Result<Self> {
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW)
            .open(path)?;
        let meta = file.metadata()?;
        ensure!(
            meta.is_file()
                && meta.nlink() == 1
                && meta.mode() & 0o077 == 0
                && meta.len() <= MAX_FRAME_BYTES as u64,
            "intent must be bounded and private"
        );
        let mut bytes = Vec::new();
        file.take(MAX_FRAME_BYTES as u64 + 1)
            .read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= MAX_FRAME_BYTES, "intent exceeds limit");
        let intent: Self = serde_json::from_slice(&bytes)?;
        intent.validate()?;
        Ok(intent)
    }
    pub fn consume(path: &Path) -> Result<()> {
        let marker = marker_path(path);
        let mut file = OpenOptions::new().create_new(true).write(true).mode(0o600).open(&marker)
            .map_err(|error| anyhow::anyhow!("intent cannot be submitted: {error}; inspect the existing operation; never delete its consumed marker to retry"))?;
        file.write_all(
            b"possibly delivered; reconcile operation.get before any further mutation\n",
        )?;
        file.sync_all()?;
        sync_parent(&marker)?;
        Ok(())
    }
}
fn marker_path(path: &Path) -> PathBuf {
    let mut marker = path.as_os_str().to_owned();
    marker.push(".sent");
    marker.into()
}
fn sync_parent(path: &Path) -> Result<()> {
    fs::File::open(
        path.parent()
            .filter(|p| !p.as_os_str().is_empty())
            .unwrap_or(Path::new(".")),
    )?
    .sync_all()?;
    Ok(())
}
