//! The credential proxy (masterplan B-5): runner protocol 4's `credential`
//! streams, carried by cubed to `CUBED_STATE/run/credential.sock` (0600, in
//! cubed's 0700 run directory). Only cubed connects, as the same user; it
//! has checked that the runner owns the machine at its current epoch.
//!
//! ```text
//! one connection = one stream from a runner
//!   u32 big-endian length (at most 64 KiB), CredentialHeader as proto3 JSON
//!   then one HTTP/1.1 request and its answer (http.rs, credential mode):
//!     Host = sni = host, port 443; every placeholder of `credential`;
//!     cubed's decision over egress.sock, as for p3; the token substituted;
//!     upstream over TLS from this host; B6 on the answer; no keep-alive
//! ```
//!
//! The token exists only in this process. A redirect is passed to the guest
//! (B6 applies to `Location` too) and never followed here.
use anyhow::{Context as _, Result, ensure};
use cube_runner_protocol::proto::CredentialHeader;
use std::{sync::Arc, time::Duration};
use tokio::{
    io::AsyncReadExt,
    net::{UnixListener, UnixStream},
};

use crate::http::{Egress, serve_credential};

/// cubed's header frame, at most.
pub const MAX_HEADER: usize = 64 * 1024;
/// cubed writes the header as soon as it connects.
const HEADER_TIMEOUT: Duration = Duration::from_secs(10);

/// Serves the credential socket until the listener fails.
pub async fn serve(listener: UnixListener, egress: Arc<Egress>) -> Result<()> {
    loop {
        let (stream, _) = listener.accept().await?;
        let egress = egress.clone();
        tokio::spawn(async move {
            if let Err(error) = connection(stream, egress).await {
                eprintln!("cube-gateway: credential stream: {error:#}");
            }
        });
    }
}

async fn connection(mut stream: UnixStream, egress: Arc<Egress>) -> Result<()> {
    let header = tokio::time::timeout(HEADER_TIMEOUT, read_header(&mut stream))
        .await
        .context("no credential header in time")??;
    let (vm_id, thread_id, sni, credential) = check(header)?;
    serve_credential(egress, vm_id, thread_id, sni, credential, stream).await
}

async fn read_header(stream: &mut UnixStream) -> Result<CredentialHeader> {
    let size = stream.read_u32().await? as usize;
    ensure!(
        size > 0 && size <= MAX_HEADER,
        "invalid header length {size}"
    );
    let mut payload = vec![0; size];
    stream.read_exact(&mut payload).await?;
    Ok(serde_json::from_slice(&payload)?)
}

/// The machine (vm id, thread id), the server name and the credential.
fn check(header: CredentialHeader) -> Result<(String, String, String, String)> {
    let reference = header.r#ref.context("the header has no machine")?;
    ensure!(
        !reference.owner.is_empty() && !reference.id.is_empty(),
        "the header has no machine"
    );
    ensure!(
        !header.credential.is_empty(),
        "the header names no credential"
    );
    let sni = header.sni.to_ascii_lowercase();
    ensure!(
        !sni.is_empty() && sni == header.host.to_ascii_lowercase() && header.port == 443,
        "a credential request is HTTPS to its server name on 443 (sni {:?}, host {:?}, port {})",
        header.sni,
        header.host,
        header.port
    );
    Ok((reference.id, reference.owner, sni, header.credential))
}

#[cfg(test)]
mod tests {
    use super::*;
    use cube_runner_protocol::proto::Ref;

    fn header(sni: &str, host: &str, port: u32) -> CredentialHeader {
        CredentialHeader {
            r#ref: Some(Ref {
                owner: "thread-1".into(),
                id: "0123456789abcdef".into(),
            }),
            credential: "github".into(),
            sni: sni.into(),
            host: host.into(),
            port,
            fence: None,
        }
    }

    #[test]
    fn the_header_must_name_a_machine_a_credential_and_https_to_its_server_name() {
        assert_eq!(
            check(header("api.github.com", "API.github.com", 443)).unwrap(),
            (
                "0123456789abcdef".into(),
                "thread-1".into(),
                "api.github.com".into(),
                "github".into()
            )
        );
        assert!(check(header("api.github.com", "github.com", 443)).is_err());
        assert!(check(header("api.github.com", "api.github.com", 80)).is_err());
        assert!(check(header("", "", 443)).is_err());
        let mut nameless = header("github.com", "github.com", 443);
        nameless.credential.clear();
        assert!(check(nameless).is_err());
        let mut nobody = header("github.com", "github.com", 443);
        nobody.r#ref = None;
        assert!(check(nobody).is_err());
    }
}
