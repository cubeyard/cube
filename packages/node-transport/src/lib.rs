//! Authenticated node protocol (loopback by default) and the trusted runner
//! that hosts one QEMU VM per active thread (protocol 3).
//! Bounded frames, no retries, no 0-RTT; VMs outlive their connection.
pub mod journal;
pub mod l2;
pub mod pump;
pub mod runner;
pub mod seed;
pub mod vm;
use std::{net::SocketAddr, sync::Arc, time::Duration};

use anyhow::{Context, Result, bail, ensure};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey, endpoint::presets};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use tokio::{io::AsyncRead, io::AsyncReadExt, task::JoinSet, time::timeout};

pub const ALPN: &[u8] = b"cubeyard/node/1";
/// Protocol 3 replaces runner command execution, file operations and Git
/// with VM lifecycle (`vm.*`). Older peers get `INCOMPATIBLE_PROTOCOL`.
pub const PROTOCOL_VERSION: u32 = 3;
pub const MIN_COMPATIBLE_PROTOCOL_VERSION: u32 = 3;
pub const SOFTWARE_VERSION: &str = env!("CARGO_PKG_VERSION");
const RUNNER_CAPABILITIES: [&str; 7] = [
    "node.status",
    "vm.allocate",
    "vm.start",
    "vm.stop",
    "vm.inspect",
    "vm.release",
    "vm.discard",
];
const KNOWN_METHODS: [&str; 8] = [
    "node.hello",
    "node.status",
    "vm.allocate",
    "vm.start",
    "vm.stop",
    "vm.inspect",
    "vm.release",
    "vm.discard",
];
pub const MAX_FRAME_BYTES: usize = 1024 * 1024;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(5);
pub const RELAY_READY_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CONNECTIONS: usize = 16;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "method", deny_unknown_fields)]
pub enum Request {
    #[serde(rename = "node.hello")]
    Hello {
        #[serde(rename = "protocolVersion")]
        protocol_version: u32,
    },
    #[serde(rename = "node.status")]
    Status,
    #[serde(rename = "vm.allocate")]
    VmAllocate {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "vmId")]
        vm_id: String,
        epoch: u64,
        #[serde(rename = "diskGiB")]
        disk_gib: u32,
    },
    #[serde(rename = "vm.start")]
    VmStart {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "vmId")]
        vm_id: String,
        epoch: u64,
        vcpus: u32,
        #[serde(rename = "memoryMiB")]
        memory_mib: u32,
        mac: String,
        seed: seed::Seed,
        gateway: runner::GatewayGrant,
    },
    #[serde(rename = "vm.stop")]
    VmStop {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "vmId")]
        vm_id: String,
        epoch: u64,
    },
    #[serde(rename = "vm.inspect")]
    VmInspect {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "vmId")]
        vm_id: String,
    },
    #[serde(rename = "vm.release")]
    VmRelease {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "vmId")]
        vm_id: String,
        epoch: u64,
        retain: bool,
    },
    /// Deletes a retained VM's disk on the operator's request.
    #[serde(rename = "vm.discard")]
    VmDiscard {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "vmId")]
        vm_id: String,
        epoch: u64,
    },
}

impl Request {
    fn vm_id(&self) -> Option<&str> {
        match self {
            Self::VmAllocate { vm_id, .. }
            | Self::VmStart { vm_id, .. }
            | Self::VmStop { vm_id, .. }
            | Self::VmInspect { vm_id, .. }
            | Self::VmRelease { vm_id, .. }
            | Self::VmDiscard { vm_id, .. } => Some(vm_id),
            _ => None,
        }
    }
    fn mutation(&self) -> bool {
        matches!(
            self,
            Self::VmAllocate { .. }
                | Self::VmStart { .. }
                | Self::VmStop { .. }
                | Self::VmRelease { .. }
                | Self::VmDiscard { .. }
        )
    }
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
        #[serde(default, skip_serializing_if = "Option::is_none")]
        platform: Option<String>,
        #[serde(
            rename = "baseImageSha256",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        base_image_sha256: Option<String>,
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
    Vm {
        vm: runner::VmRecord,
        /// Last 16 KiB of the serial console; `vm.inspect` only.
        #[serde(
            rename = "consoleTail",
            default,
            skip_serializing_if = "Option::is_none"
        )]
        console_tail: Option<String>,
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
    pub max_vcpus: u32,
    #[serde(rename = "maxMemoryMiB")]
    pub max_memory_mib: u32,
    #[serde(rename = "maxDiskGiB")]
    pub max_disk_gib: u32,
    pub max_seed_bytes: usize,
    pub max_active_vms: u64,
}

impl Limits {
    pub fn current(limits: &runner::VmLimits) -> Self {
        Self {
            max_frame_bytes: MAX_FRAME_BYTES,
            request_timeout_ms: REQUEST_TIMEOUT.as_millis() as u64,
            max_vcpus: limits.max_vcpus,
            max_memory_mib: limits.max_memory_mib,
            max_disk_gib: limits.max_disk_gib,
            max_seed_bytes: seed::MAX_SEED_BYTES,
            max_active_vms: runner::MAX_ACTIVE_VMS,
        }
    }
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
async fn bind_transport(
    key: SecretKey,
    listen: SocketAddr,
    alpns: Vec<Vec<u8>>,
) -> Result<Endpoint> {
    Ok(Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .alpns(alpns)
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
/// A runner accepts control (`cubeyard/node/1`) and frame (`cube/l2/1`)
/// connections on one endpoint.
pub async fn bind_relay_runner(key: SecretKey) -> Result<Endpoint> {
    bind_relay_transport(key, runner_alpns()).await
}
fn runner_alpns() -> Vec<Vec<u8>> {
    vec![ALPN.to_vec(), l2::L2_ALPN.to_vec()]
}
pub async fn bind_relay_client(key: SecretKey) -> Result<Endpoint> {
    bind_relay_transport(key, vec![]).await
}
pub async fn bind_node(key: SecretKey, listen: SocketAddr, mode: NetworkMode) -> Result<Endpoint> {
    check_listener(listen, mode)?;
    bind_transport(key, listen, vec![ALPN.to_vec()]).await
}
pub async fn bind_runner(
    key: SecretKey,
    listen: SocketAddr,
    mode: NetworkMode,
) -> Result<Endpoint> {
    check_listener(listen, mode)?;
    bind_transport(key, listen, runner_alpns()).await
}
fn check_listener(listen: SocketAddr, mode: NetworkMode) -> Result<()> {
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
    Ok(())
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
    bind_transport(key, local.parse()?, vec![ALPN.to_vec()]).await
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

fn hello(node_id: &str, query: &Request) -> Response {
    match query {
        Request::Hello {
            protocol_version: PROTOCOL_VERSION,
        } => Response::Hello {
            node_id: node_id.into(),
            protocol_version: PROTOCOL_VERSION,
            // The plain serve probe never enables the runner.
            profiles: vec![],
            capabilities: vec!["node.hello".into()],
            limits: Limits::current(&runner::VmLimits::default()),
            minimum_protocol_version: MIN_COMPATIBLE_PROTOCOL_VERSION,
            software_version: SOFTWARE_VERSION.into(),
            binding: None,
            platform: None,
            base_image_sha256: None,
        },
        _ => Response::error(
            "INCOMPATIBLE_PROTOCOL",
            "protocol version 3 required; upgrade cubed or cube-runner",
        ),
    }
}

fn runner_hello(node_id: &str, query: &Request, runner: &runner::Runner) -> Response {
    let mut result = hello(node_id, query);
    if let Response::Hello {
        profiles,
        capabilities,
        binding,
        limits,
        platform,
        base_image_sha256,
        ..
    } = &mut result
    {
        let installation = runner.installation();
        *binding = Some(installation.binding.clone());
        *profiles = vec!["runner".into()];
        capabilities.extend(RUNNER_CAPABILITIES.map(String::from));
        *limits = Limits::current(&installation.limits);
        *platform = Some(installation.platform.clone());
        *base_image_sha256 = Some(installation.image.sha256.clone());
    }
    result
}

async fn dispatch(node_id: &str, query: Request, runner: Option<&Arc<runner::Runner>>) -> Response {
    if matches!(query, Request::Hello { .. }) {
        return match runner {
            Some(runner) => runner_hello(node_id, &query, runner),
            None => hello(node_id, &query),
        };
    }
    let Some(runner) = runner else {
        return Response::error("UNSUPPORTED", "this node does not host VMs");
    };
    let mutation = query.mutation();
    let vm = |vm| Response::Vm {
        vm,
        console_tail: None,
    };
    let result = match query {
        Request::Status => runner.status().map(|status| Response::Status {
            node_id: node_id.into(),
            protocol_version: PROTOCOL_VERSION,
            minimum_protocol_version: MIN_COMPATIBLE_PROTOCOL_VERSION,
            software_version: SOFTWARE_VERSION.into(),
            binding: runner.installation().binding.clone(),
            status,
        }),
        Request::VmAllocate {
            thread_id,
            vm_id,
            epoch,
            disk_gib,
        } => runner
            .allocate(&thread_id, &vm_id, epoch, disk_gib)
            .await
            .map(vm),
        Request::VmStart {
            thread_id,
            vm_id,
            epoch,
            vcpus,
            memory_mib,
            mac,
            seed,
            gateway,
        } => runner
            .start(
                &thread_id,
                &vm_id,
                epoch,
                runner::StartSpec {
                    vcpus,
                    memory_mib,
                    mac,
                    seed,
                    gateway,
                },
            )
            .await
            .map(vm),
        Request::VmStop {
            thread_id,
            vm_id,
            epoch,
        } => runner.stop(&thread_id, &vm_id, epoch).await.map(vm),
        Request::VmInspect { thread_id, vm_id } => runner
            .inspect(&thread_id, &vm_id)
            .map(|(vm, console_tail)| Response::Vm { vm, console_tail }),
        Request::VmRelease {
            thread_id,
            vm_id,
            epoch,
            retain,
        } => runner
            .release(&thread_id, &vm_id, epoch, retain)
            .await
            .map(vm),
        Request::VmDiscard {
            thread_id,
            vm_id,
            epoch,
        } => runner.discard(&thread_id, &vm_id, epoch).map(vm),
        Request::Hello { .. } => unreachable!(),
    };
    result.unwrap_or_else(|error| {
        if let Some(error) = error.downcast_ref::<runner::RunnerError>() {
            Response::error(error.0, "runner request rejected")
        } else if let Some(error) = error.downcast_ref::<runner::RunnerErrorDetail>() {
            Response::Error {
                code: error.0.into(),
                message: error.1.clone(),
                completion_unknown: false,
            }
        } else {
            // A journal commit may have happened. Do not assert no side effects.
            Response::Error {
                code: "IO_ERROR".into(),
                message: "runner state could not be confirmed".into(),
                completion_unknown: mutation,
            }
        }
    })
}

/// Parses a request frame. A well-formed frame naming a method this
/// protocol does not have is `UNSUPPORTED`, not `INVALID_REQUEST`.
fn parse_request(
    value: serde_json::Value,
) -> std::result::Result<Request, (&'static str, &'static str)> {
    let method = value.get("method").and_then(|m| m.as_str()).unwrap_or("");
    if !method.is_empty() && !KNOWN_METHODS.contains(&method) {
        return Err(("UNSUPPORTED", "unknown method"));
    }
    serde_json::from_value(value).map_err(|_| ("INVALID_REQUEST", "invalid request frame"))
}

/// Authenticate before application data. A successful hello is required on
/// this SAME connection before any other request. Each connection gets at
/// most two streams: hello and one request; the client never retries.
/// Runs a request in its own task. The control connection is bounded by
/// REQUEST_TIMEOUT; a runner mutation must not be cancelled half way (a VM
/// left `starting` or `allocating`), so it finishes even when the caller's
/// connection is gone. The caller learns the outcome from `vm.inspect`.
async fn dispatch_detached(
    node_id: &str,
    query: Request,
    runner: Option<&Arc<runner::Runner>>,
) -> Response {
    let node_id = node_id.to_owned();
    let runner = runner.cloned();
    let mutation = query.mutation();
    match tokio::spawn(async move { dispatch(&node_id, query, runner.as_ref()).await }).await {
        Ok(response) => response,
        Err(_) => Response::Error {
            code: "IO_ERROR".into(),
            message: "runner state could not be confirmed".into(),
            completion_unknown: mutation,
        },
    }
}

async fn accept_control(
    connection: iroh::endpoint::Connection,
    allowed_peer: EndpointId,
    node_id: String,
    runner: Option<Arc<runner::Runner>>,
) -> Result<()> {
    if connection.remote_id() != allowed_peer {
        connection.close(1u32.into(), b"UNAUTHORIZED");
        bail!("unauthorized peer");
    }
    let mut negotiated = false;
    for _ in 0..2 {
        let (mut send, mut recv) = connection.accept_bi().await?;
        let response = match read_frame::<serde_json::Value>(&mut recv).await {
            Ok(value) if !negotiated => match serde_json::from_value::<Request>(value) {
                Ok(query @ Request::Hello { .. }) => {
                    let response = dispatch(&node_id, query, runner.as_ref()).await;
                    negotiated = matches!(
                        response,
                        Response::Hello {
                            protocol_version: PROTOCOL_VERSION,
                            ..
                        }
                    );
                    response
                }
                _ => Response::error("INVALID_REQUEST", "hello required before other requests"),
            },
            Ok(value) => match parse_request(value) {
                Ok(Request::Hello { .. }) => {
                    Response::error("INVALID_REQUEST", "hello already completed")
                }
                Ok(query) => dispatch_detached(&node_id, query, runner.as_ref()).await,
                Err((code, message)) => Response::error(code, message),
            },
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

/// Control connections are bounded and short; frame connections (`cube/l2/1`,
/// runner only) live as long as the gateway keeps them. Dropping connection
/// tasks never stops a VM: graceful shutdown goes through Runner::shutdown().
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
    let pumps = runner.as_ref().map(|runner| runner.pumps());
    let mut tasks = JoinSet::new();
    let mut frames = JoinSet::new();
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
                let pumps = pumps.clone();
                tasks.spawn(async move {
                    let Ok(Ok(connection)) = timeout(REQUEST_TIMEOUT, incoming).await else {
                        return None;
                    };
                    if connection.alpn() == l2::L2_ALPN {
                        return match pumps {
                            Some(pumps) => Some((pumps, connection)),
                            None => {
                                connection.close(1u32.into(), b"UNSUPPORTED");
                                None
                            }
                        };
                    }
                    let _ = timeout(
                        REQUEST_TIMEOUT,
                        accept_control(connection, allowed_peer, node_id, runner),
                    )
                    .await;
                    None
                });
            }
            Some(done) = tasks.join_next(), if !tasks.is_empty() => {
                if let Ok(Some((pumps, connection))) = done {
                    frames.spawn(pumps.serve(connection));
                }
            }
            Some(_) = frames.join_next(), if !frames.is_empty() => {}
        }
    }
    tasks.abort_all();
    frames.abort_all();
    while tasks.join_next().await.is_some() {}
    while frames.join_next().await.is_some() {}
    Ok(())
}

#[derive(Debug)]
pub struct DeliveryError {
    pub code: &'static str,
    pub completion_unknown: bool,
}
impl std::fmt::Display for DeliveryError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "{}: completionUnknown={}",
            self.code, self.completion_unknown
        )
    }
}
impl std::error::Error for DeliveryError {}

/// Call exactly once, negotiating identity on the same connection before
/// work. Every `vm.*` mutation is idempotent by content, so after a possible
/// delivery the caller inspects (`vm.inspect`) or repeats the same request.
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
    let mutation = query.mutation();
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
                }
                .into());
            }
        }
        let (mut send, mut recv) = connection.open_bi().await?;
        possible_delivery = mutation;
        send.write_all(&bytes).await?;
        send.finish()?;
        let response: Response = read_frame(&mut recv).await?;
        match (&response, query) {
            (Response::Vm { vm, .. }, query) if Some(vm.vm_id.as_str()) == query.vm_id() => {}
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
        }
        .into()),
    }
}

/// `address.id` is the pinned, enrolled server peer key, not an unauthenticated
/// value learned from hello. Expected logical identity is checked separately.
/// This read-only probe never retries and never starts a VM.
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
            serde_json::json!({"method":"vm.start"}),
            serde_json::json!({"method":"node.hello", "protocolVersion":3, "nodeId":"spoof"}),
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
        for version in [1, 2, 4] {
            assert!(
                matches!(hello("node-test", &Request::Hello { protocol_version: version }), Response::Error { code, .. } if code == "INCOMPATIBLE_PROTOCOL")
            );
        }
        for id in ["", "node-", "other-node", "node-../etc", "node-é"] {
            assert!(validate_node_id(id).is_err());
        }
    }

    #[test]
    fn unknown_methods_are_unsupported() {
        for method in [
            "exec.start",
            "fs.read",
            "workspace.allocate.v2",
            "vm.snapshot",
        ] {
            assert!(
                matches!(
                    parse_request(serde_json::json!({"method": method})),
                    Err(("UNSUPPORTED", _))
                ),
                "{method}"
            );
        }
        assert!(matches!(
            parse_request(serde_json::json!({"method": "vm.stop"})),
            Err(("INVALID_REQUEST", _))
        ));
        assert!(matches!(
            parse_request(serde_json::json!({"nothing": 1})),
            Err(("INVALID_REQUEST", _))
        ));
    }

    #[test]
    fn vm_start_wire_shape() {
        let value = serde_json::json!({
            "method": "vm.start", "threadId": "t1", "vmId": "0123456789abcdef", "epoch": 2,
            "vcpus": 2, "memoryMiB": 2048, "mac": "02:00:00:00:00:01",
            "seed": {"metaData": "m", "userData": "u", "networkConfig": ""},
            "gateway": {"peer": "p", "frameToken": "t"},
        });
        let request: Request = serde_json::from_value(value.clone()).unwrap();
        assert_eq!(serde_json::to_value(&request).unwrap(), value);
        let mut extra = value;
        extra["workspace"] = serde_json::json!("/x");
        assert!(serde_json::from_value::<Request>(extra).is_err());
    }

    #[test]
    fn runner_capabilities_are_versioned() {
        assert_eq!(
            (SOFTWARE_VERSION, RUNNER_CAPABILITIES),
            (
                "0.5.0",
                [
                    "node.status",
                    "vm.allocate",
                    "vm.start",
                    "vm.stop",
                    "vm.inspect",
                    "vm.release",
                    "vm.discard",
                ]
            ),
            "capability changes require a new immutable software version"
        );
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
