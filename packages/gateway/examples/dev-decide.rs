//! Development decision server: answers `POST /v1/decide` on a unix socket
//! with allow (no substitutions), logging each request to stderr. Stands in
//! for cubed's egress policy in manual runs.
//!
//! cargo run -p cube-gateway --example dev-decide -- egress.sock
use anyhow::{Context, Result};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::service::service_fn;
use hyper_util::rt::TokioIo;
use tokio::net::UnixListener;

#[tokio::main]
async fn main() -> Result<()> {
    let path = std::env::args()
        .nth(1)
        .context("usage: dev-decide <socket>")?;
    let _ = std::fs::remove_file(&path);
    let listener = UnixListener::bind(&path)?;
    eprintln!("dev-decide: allowing everything on {path}");
    loop {
        let (stream, _) = listener.accept().await?;
        tokio::spawn(async move {
            let service = service_fn(
                |request: hyper::Request<hyper::body::Incoming>| async move {
                    let body = request.into_body().collect().await?.to_bytes();
                    eprintln!("dev-decide: {}", String::from_utf8_lossy(&body));
                    Ok::<_, hyper::Error>(hyper::Response::new(Full::new(Bytes::from_static(
                        br#"{"allow":true}"#,
                    ))))
                },
            );
            let _ = hyper::server::conn::http1::Builder::new()
                .serve_connection(TokioIo::new(stream), service)
                .await;
        });
    }
}
