//! Fakes shared by the gateway's integration tests: cubed's decision
//! server, a CA for fake upstreams and one HTTP/1.1 exchange.
#![allow(dead_code)]

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use rustls::{RootCertStore, pki_types::CertificateDer};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    net::UnixListener,
};

pub const VM_ID: &str = "0123456789abcdef";
pub const THREAD_ID: &str = "thread-1";
pub const GH: &str = "cube_ph_github_AbCdEfGhIjKlMnOpQrStUv";
pub const OTHER: &str = "cube_ph_npm_0123456789abcdefABCDEF";

/// A cubed decision server on a unix socket. `decide` maps the request JSON
/// to (delay, answer).
pub struct FakeDecide {
    pub requests: Arc<Mutex<Vec<serde_json::Value>>>,
}

pub type DecideFn = Arc<dyn Fn(&serde_json::Value) -> (Duration, serde_json::Value) + Send + Sync>;

impl FakeDecide {
    pub fn start(path: PathBuf, decide: DecideFn) -> Self {
        let listener = UnixListener::bind(&path).unwrap();
        let requests = Arc::new(Mutex::new(vec![]));
        let recorded = requests.clone();
        tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    return;
                };
                let (decide, recorded) = (decide.clone(), recorded.clone());
                tokio::spawn(async move {
                    let service =
                        service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                            let (decide, recorded) = (decide.clone(), recorded.clone());
                            async move {
                                assert_eq!(request.uri().path(), "/v1/decide");
                                let body = request.into_body().collect().await?.to_bytes();
                                let value: serde_json::Value =
                                    serde_json::from_slice(&body).unwrap();
                                recorded.lock().unwrap().push(value.clone());
                                let (delay, answer) = decide(&value);
                                tokio::time::sleep(delay).await;
                                Ok::<_, hyper::Error>(hyper::Response::new(Full::new(Bytes::from(
                                    serde_json::to_vec(&answer).unwrap(),
                                ))))
                            }
                        });
                    let _ = hyper::server::conn::http1::Builder::new()
                        .serve_connection(TokioIo::new(stream), service)
                        .await;
                });
            }
        });
        Self { requests }
    }
}

pub fn allow_with(substitute: &[(&str, &str)]) -> DecideFn {
    let substitute: serde_json::Map<String, serde_json::Value> = substitute
        .iter()
        .map(|(k, v)| (k.to_string(), serde_json::Value::String(v.to_string())))
        .collect();
    Arc::new(move |_| {
        (
            Duration::ZERO,
            serde_json::json!({"allow": true, "substitute": substitute.clone()}),
        )
    })
}

/// A CA for fake upstreams, trusted by the gateway through test hooks.
pub struct UpstreamCa {
    pub issuer: rcgen::Issuer<'static, rcgen::KeyPair>,
    pub der: CertificateDer<'static>,
}

impl UpstreamCa {
    pub fn new() -> Self {
        let key = rcgen::KeyPair::generate().unwrap();
        let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
        params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
        params
            .distinguished_name
            .push(rcgen::DnType::CommonName, "fake upstream CA");
        let cert = params.self_signed(&key).unwrap();
        Self {
            der: cert.der().clone(),
            issuer: rcgen::Issuer::new(params, key),
        }
    }

    pub fn roots(&self) -> RootCertStore {
        let mut roots = RootCertStore::empty();
        roots.add(self.der.clone()).unwrap();
        roots
    }
}

/// One HTTP/1.1 exchange over `io`; returns status, headers and body.
pub async fn request<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    io: S,
    request: hyper::Request<Full<Bytes>>,
) -> (hyper::StatusCode, hyper::HeaderMap, Bytes) {
    let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(io))
        .await
        .unwrap();
    tokio::spawn(connection);
    let response = sender.send_request(request).await.unwrap();
    let (parts, body) = response.into_parts();
    (
        parts.status,
        parts.headers,
        body.collect().await.unwrap().to_bytes(),
    )
}

pub fn get(host: &str, path: &str, headers: &[(&str, String)]) -> hyper::Request<Full<Bytes>> {
    let mut builder = hyper::Request::get(path).header("host", host);
    for (k, v) in headers {
        builder = builder.header(*k, v);
    }
    builder.body(Full::new(Bytes::new())).unwrap()
}
