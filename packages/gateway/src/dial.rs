//! `cube-gateway dial`: OpenSSH `ProxyCommand` side of the guest dial. It
//! asks the control socket for an upgraded TCP stream to the guest and
//! splices it with stdin/stdout.
use anyhow::{Context, Result, bail, ensure};
use std::path::Path;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::UnixStream,
};

use crate::control::{UPGRADE_PROTOCOL, valid_vm_id};

const MAX_RESPONSE_HEAD: usize = 16 * 1024;

/// An upgraded stream to the guest and any bytes that followed the 101.
pub struct Dialed {
    pub stream: UnixStream,
    pub early: Vec<u8>,
}

pub async fn open(control: &Path, vm_id: &str, port: u16) -> Result<Dialed> {
    ensure!(valid_vm_id(vm_id), "invalid vm id");
    let mut stream = UnixStream::connect(control)
        .await
        .with_context(|| format!("connect {}", control.display()))?;
    let request = format!(
        "POST /v1/vms/{vm_id}/dial?port={port} HTTP/1.1\r\nHost: gateway\r\nConnection: Upgrade\r\nUpgrade: {UPGRADE_PROTOCOL}\r\nContent-Length: 0\r\n\r\n"
    );
    stream.write_all(request.as_bytes()).await?;
    let mut head = Vec::with_capacity(1024);
    let mut buf = [0u8; 1024];
    let end = loop {
        let n = stream.read(&mut buf).await?;
        if n == 0 {
            bail!("gateway closed the connection");
        }
        head.extend_from_slice(&buf[..n]);
        if let Some(end) = head.windows(4).position(|w| w == b"\r\n\r\n") {
            break end + 4;
        }
        ensure!(
            head.len() <= MAX_RESPONSE_HEAD,
            "gateway response too large"
        );
    };
    let early = head.split_off(end);
    let text = String::from_utf8_lossy(&head);
    let status = text.split_whitespace().nth(1).unwrap_or_default();
    if status != "101" {
        // The error body (JSON) may follow; show what arrived.
        let body = String::from_utf8_lossy(&early);
        bail!(
            "gateway refused the dial: {} {}",
            text.lines().next().unwrap_or_default(),
            body.trim()
        );
    }
    Ok(Dialed { stream, early })
}

/// Splices stdin/stdout with the guest connection until either side ends.
pub async fn run(control: &Path, vm_id: &str, port: u16) -> Result<()> {
    let Dialed { stream, early } = open(control, vm_id, port).await?;
    let (mut read, mut write) = stream.into_split();
    let mut stdout = tokio::io::stdout();
    let mut stdin = tokio::io::stdin();
    let down = async {
        stdout.write_all(&early).await?;
        stdout.flush().await?;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = read.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            stdout.write_all(&buf[..n]).await?;
            stdout.flush().await?;
        }
        anyhow::Ok(())
    };
    let up = async {
        tokio::io::copy(&mut stdin, &mut write).await?;
        write.shutdown().await?;
        anyhow::Ok(())
    };
    // The guest closing ends the session; stdin EOF only half-closes.
    tokio::select! {
        r = down => r,
        r = async { up.await?; std::future::pending::<Result<()>>().await } => r,
    }
}
