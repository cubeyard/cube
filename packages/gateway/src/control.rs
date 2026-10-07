//! Control API, HTTP/1.1 on `CUBED_STATE/run/gateway.sock` (0600), used
//! only by cubed.
//!
//! | Route | Result |
//! |---|---|
//! | `GET /v1/hello` | `{version, peer, network, caPem, caSha256}` |
//! | `PUT /v1/vms/{vmId}` | attach: `{threadId, runner, frameToken, mac}` → status |
//! | `DELETE /v1/vms/{vmId}` | detach → 204 |
//! | `GET /v1/vms/{vmId}` | status |
//! | `GET /v1/vms` | `{vms: [status…]}` |
//! | `POST /v1/vms/{vmId}/dial?port=N` | `Upgrade: cube-tcp` → 101, raw bytes to guest:N (22 or 1024-65535) |
use anyhow::Result;
use bytes::Bytes;
use cube_node_transport::{NetworkMode, l2::FrameHello, l2::valid_frame_token};
use http::{HeaderValue, Method, Request, Response, StatusCode, header};
use http_body_util::{BodyExt, Full, Limited};
use hyper::{body::Incoming, service::service_fn};
use hyper_util::rt::TokioIo;
use iroh::Endpoint;
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::net::UnixListener;

use crate::{
    http::{Egress, VmEgress},
    lan::{self, Dialer, FlowStream, GUEST_IP, Lan, LanConfig, LanLimits, Resolver},
    link::{IrohSink, Link, LinkState, RunnerTarget, Slot},
};

pub const UPGRADE_PROTOCOL: &str = "cube-tcp";
/// The guest's sshd (cubed's tools) and the unprivileged ports its services
/// listen on (cubed's portal, which only dials ports the guest registered).
pub fn dial_allowed(port: u16) -> bool {
    port == 22 || port >= 1024
}
const MAX_BODY: usize = 64 * 1024;
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AttachSpec {
    pub thread_id: String,
    pub runner: RunnerTarget,
    pub frame_token: String,
    pub mac: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VmStatus {
    pub vm_id: String,
    pub thread_id: String,
    pub link: LinkState,
    pub leased: bool,
    pub guest_ip: Option<String>,
    pub flows: usize,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub last_error: Option<String>,
    pub dropped_frames: u64,
    pub path: Option<crate::link::PathReport>,
}

struct Vm {
    spec: AttachSpec,
    lan: Lan,
    slot: Arc<Slot>,
    link: Link,
}

pub struct Gateway {
    endpoint: Endpoint,
    network: NetworkMode,
    egress: Arc<Egress>,
    resolver: Arc<dyn Resolver>,
    limits: LanLimits,
    vms: Mutex<HashMap<String, Vm>>,
}

#[derive(Debug)]
pub struct ApiError(pub StatusCode, pub String);

fn bad(message: impl Into<String>) -> ApiError {
    ApiError(StatusCode::BAD_REQUEST, message.into())
}

pub fn valid_vm_id(id: &str) -> bool {
    id.len() == 16
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

pub fn valid_thread_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

impl Gateway {
    pub fn new(
        endpoint: Endpoint,
        network: NetworkMode,
        egress: Arc<Egress>,
        resolver: Arc<dyn Resolver>,
        limits: LanLimits,
    ) -> Self {
        Self {
            endpoint,
            network,
            egress,
            resolver,
            limits,
            vms: Mutex::new(HashMap::new()),
        }
    }

    pub fn hello(&self) -> serde_json::Value {
        serde_json::json!({
            "version": crate::VERSION,
            "peer": self.endpoint.id().to_string(),
            "network": self.network,
            "caPem": self.egress.ca.pem(),
            "caSha256": self.egress.ca.sha256(),
        })
    }

    /// Creates the VM's LAN and starts dialling its runner. A changed token
    /// or runner replaces the link and keeps the LAN (and its flows).
    pub fn attach(&self, vm_id: &str, spec: AttachSpec) -> Result<VmStatus, ApiError> {
        if !valid_vm_id(vm_id) {
            return Err(bad("vmId must be 16 lowercase hex characters"));
        }
        if !valid_thread_id(&spec.thread_id) {
            return Err(bad("invalid threadId"));
        }
        if !valid_frame_token(&spec.frame_token) {
            return Err(bad("frameToken must be 64 lowercase hex characters"));
        }
        let mac = lan::parse_mac(&spec.mac).map_err(|e| bad(e.to_string()))?;
        let address = spec
            .runner
            .endpoint_addr(self.network)
            .map_err(|e| bad(format!("{e:#}")))?;
        let hello = FrameHello {
            vm_id: vm_id.to_string(),
            thread_id: spec.thread_id.clone(),
            frame_token: spec.frame_token.clone(),
        };
        let mut vms = self.vms.lock().unwrap();
        if let Some(vm) = vms.get_mut(vm_id) {
            if vm.spec.thread_id != spec.thread_id || vm.spec.mac != spec.mac {
                return Err(ApiError(
                    StatusCode::CONFLICT,
                    "vm is attached with another thread or MAC".into(),
                ));
            }
            if vm.spec != spec {
                vm.link = Link::spawn(
                    self.endpoint.clone(),
                    address,
                    hello,
                    vm.lan.input(),
                    vm.slot.clone(),
                );
                vm.spec = spec;
            }
            return Ok(status(vm_id, vm));
        }
        let slot = Slot::new();
        let lan = Lan::spawn(
            LanConfig {
                vm_id: vm_id.to_string(),
                mac,
                limits: self.limits.clone(),
            },
            Box::new(IrohSink::new(&slot)),
            Arc::new(VmEgress::new(
                self.egress.clone(),
                vm_id.to_string(),
                spec.thread_id.clone(),
            )),
            self.resolver.clone(),
        );
        let link = Link::spawn(
            self.endpoint.clone(),
            address,
            hello,
            lan.input(),
            slot.clone(),
        );
        let vm = Vm {
            spec,
            lan,
            slot,
            link,
        };
        let result = status(vm_id, &vm);
        vms.insert(vm_id.to_string(), vm);
        eprintln!("cube-gateway: attached vm {vm_id}");
        Ok(result)
    }

    pub fn detach(&self, vm_id: &str) -> bool {
        let removed = self.vms.lock().unwrap().remove(vm_id);
        if removed.is_some() {
            eprintln!("cube-gateway: detached vm {vm_id}");
        }
        removed.is_some()
    }

    pub fn status(&self, vm_id: &str) -> Option<VmStatus> {
        self.vms
            .lock()
            .unwrap()
            .get(vm_id)
            .map(|vm| status(vm_id, vm))
    }

    pub fn list(&self) -> Vec<VmStatus> {
        let vms = self.vms.lock().unwrap();
        let mut list: Vec<_> = vms.iter().map(|(id, vm)| status(id, vm)).collect();
        list.sort_by(|a, b| a.vm_id.cmp(&b.vm_id));
        list
    }

    fn dialer(&self, vm_id: &str) -> Option<Dialer> {
        self.vms
            .lock()
            .unwrap()
            .get(vm_id)
            .map(|vm| vm.lan.dialer())
    }

    /// TCP to the guest from 10.77.0.1, for cubed's SSH and portal.
    pub async fn dial(&self, vm_id: &str, port: u16) -> Result<FlowStream, ApiError> {
        if !dial_allowed(port) {
            return Err(ApiError(
                StatusCode::FORBIDDEN,
                format!("dialling guest port {port} is not allowed"),
            ));
        }
        let Some(dialer) = self.dialer(vm_id) else {
            return Err(ApiError(StatusCode::NOT_FOUND, "vm is not attached".into()));
        };
        match tokio::time::timeout(DIAL_TIMEOUT, dialer.dial(port)).await {
            Ok(Ok(stream)) => Ok(stream),
            Ok(Err(e)) => Err(ApiError(StatusCode::BAD_GATEWAY, format!("{e:#}"))),
            Err(_) => Err(ApiError(
                StatusCode::BAD_GATEWAY,
                "guest did not answer".into(),
            )),
        }
    }
}

fn status(vm_id: &str, vm: &Vm) -> VmStatus {
    use std::sync::atomic::Ordering::Relaxed;
    let stats = &vm.lan.stats;
    let link = vm.link.status.lock().unwrap();
    let leased = stats.leased.load(Relaxed);
    VmStatus {
        vm_id: vm_id.to_string(),
        thread_id: vm.spec.thread_id.clone(),
        link: link.state,
        leased,
        guest_ip: leased.then(|| GUEST_IP.to_string()),
        flows: stats.flows.load(Relaxed),
        rx_bytes: stats.rx_bytes.load(Relaxed),
        tx_bytes: stats.tx_bytes.load(Relaxed),
        last_error: link.last_error.clone(),
        dropped_frames: vm.slot.dropped.load(Relaxed),
        path: vm.slot.path(),
    }
}

type Body = http_body_util::combinators::BoxBody<Bytes, hyper::Error>;

fn json(status: StatusCode, value: &impl Serialize) -> Response<Body> {
    let mut response = Response::new(
        Full::new(Bytes::from(serde_json::to_vec(value).unwrap_or_default()))
            .map_err(|never| match never {})
            .boxed(),
    );
    *response.status_mut() = status;
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static("application/json"),
    );
    response
}

fn error(ApiError(status, message): ApiError) -> Response<Body> {
    json(status, &serde_json::json!({ "error": message }))
}

fn empty(status: StatusCode) -> Response<Body> {
    let mut response = Response::new(
        Full::new(Bytes::new())
            .map_err(|never| match never {})
            .boxed(),
    );
    *response.status_mut() = status;
    response
}

async fn route(gateway: Arc<Gateway>, mut request: Request<Incoming>) -> Response<Body> {
    let path = request.uri().path().to_string();
    let parts: Vec<&str> = path.trim_start_matches('/').split('/').collect();
    let method = request.method().clone();
    match (&method, parts.as_slice()) {
        (&Method::GET, ["v1", "hello"]) => json(StatusCode::OK, &gateway.hello()),
        (&Method::GET, ["v1", "vms"]) => json(
            StatusCode::OK,
            &serde_json::json!({ "vms": gateway.list() }),
        ),
        (&Method::GET, ["v1", "vms", id]) => match gateway.status(id) {
            Some(status) => json(StatusCode::OK, &status),
            None => error(ApiError(StatusCode::NOT_FOUND, "vm is not attached".into())),
        },
        (&Method::PUT, ["v1", "vms", id]) => {
            let body = match Limited::new(request.into_body(), MAX_BODY).collect().await {
                Ok(body) => body.to_bytes(),
                Err(_) => return error(bad("body too large or unreadable")),
            };
            let spec: AttachSpec = match serde_json::from_slice(&body) {
                Ok(spec) => spec,
                Err(e) => return error(bad(format!("invalid attach request: {e}"))),
            };
            match gateway.attach(id, spec) {
                Ok(status) => json(StatusCode::OK, &status),
                Err(e) => error(e),
            }
        }
        (&Method::DELETE, ["v1", "vms", id]) => {
            gateway.detach(id);
            empty(StatusCode::NO_CONTENT)
        }
        (&Method::POST, ["v1", "vms", id, "dial"]) => {
            let port = request
                .uri()
                .query()
                .unwrap_or_default()
                .split('&')
                .find_map(|kv| kv.strip_prefix("port="))
                .and_then(|p| p.parse::<u16>().ok());
            let Some(port) = port else {
                return error(bad("port is required"));
            };
            let upgrade = request.headers().get(header::UPGRADE).is_some_and(|u| {
                u.as_bytes()
                    .eq_ignore_ascii_case(UPGRADE_PROTOCOL.as_bytes())
            });
            if !upgrade {
                return error(bad(format!("Upgrade: {UPGRADE_PROTOCOL} is required")));
            }
            let mut flow = match gateway.dial(id, port).await {
                Ok(flow) => flow,
                Err(e) => return error(e),
            };
            let on_upgrade = hyper::upgrade::on(&mut request);
            tokio::spawn(async move {
                if let Ok(upgraded) = on_upgrade.await {
                    let mut upgraded = TokioIo::new(upgraded);
                    let _ = tokio::io::copy_bidirectional(&mut upgraded, &mut flow).await;
                }
            });
            let mut response = empty(StatusCode::SWITCHING_PROTOCOLS);
            response
                .headers_mut()
                .insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
            response
                .headers_mut()
                .insert(header::UPGRADE, HeaderValue::from_static(UPGRADE_PROTOCOL));
            response
        }
        _ => error(ApiError(StatusCode::NOT_FOUND, "no such route".into())),
    }
}

/// Serves the control API until the listener fails.
pub async fn serve(listener: UnixListener, gateway: Arc<Gateway>) -> Result<()> {
    loop {
        let (stream, _) = listener.accept().await?;
        let gateway = gateway.clone();
        tokio::spawn(async move {
            let service = service_fn(move |request| {
                let gateway = gateway.clone();
                async move { Ok::<_, std::convert::Infallible>(route(gateway, request).await) }
            });
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .with_upgrades()
                .await;
        });
    }
}

#[cfg(test)]
mod tests {
    use super::dial_allowed;

    #[test]
    fn dials_sshd_and_unprivileged_service_ports_only() {
        assert!(dial_allowed(22));
        assert!(dial_allowed(1024));
        assert!(dial_allowed(65535));
        for port in [0, 1, 21, 23, 80, 443, 1023] {
            assert!(!dial_allowed(port), "{port}");
        }
    }
}
