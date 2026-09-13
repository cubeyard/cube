//! Explicit development CLI. Key files contain secrets; stdout only contains
//! public identities, listener addresses and the hello response.
use std::{
    collections::BTreeMap,
    fs::OpenOptions,
    io::{Read, Write},
    net::SocketAddr,
    path::Path,
};

use anyhow::{Context, Result, bail, ensure};
use cube_node_transport::{bind_loopback, query_hello, serve, validate_node_id};
use iroh::{EndpointAddr, EndpointId, SecretKey};
use serde_json::json;

const USAGE: &str = "usage:
  cube-node-transport keygen --key <new-private-file>
  cube-node-transport serve --key <private-file> --allow-peer <public-key> --node-id <node-id> [--listen 127.0.0.1:0]
  cube-node-transport hello --key <private-file> --peer <pinned-public-key> --address <loopback-ip:port> --expect-node <node-id>";

#[cfg(unix)]
fn read_key(path: &Path) -> Result<SecretKey> {
    use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .context("open private key (must already exist; no automatic identity replacement)")?;
    let metadata = file.metadata()?;
    ensure!(
        metadata.is_file() && metadata.mode() & 0o077 == 0 && metadata.nlink() == 1,
        "private key must be a regular, single-link, owner-only file"
    );
    ensure!(metadata.len() == 32, "invalid private key length");
    let mut bytes = [0u8; 32];
    file.read_exact(&mut bytes)?;
    Ok(SecretKey::from_bytes(&bytes))
}

#[cfg(unix)]
fn keygen(path: &Path) -> Result<SecretKey> {
    use std::os::unix::fs::OpenOptionsExt;
    let key = SecretKey::generate();
    // Never overwrite a key or follow an existing symlink. An interrupted
    // partial write fails subsequent reads; it does not mint another identity.
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(&key.to_bytes())?;
    file.sync_all()?;
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    std::fs::File::open(parent)?.sync_all()?;
    Ok(key)
}

fn take(options: &mut BTreeMap<String, String>, key: &str) -> Result<String> {
    options
        .remove(key)
        .with_context(|| format!("missing {key}\n{USAGE}"))
}
fn no_extra(options: &BTreeMap<String, String>) -> Result<()> {
    ensure!(options.is_empty(), "unknown options\n{USAGE}");
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().context(USAGE)?;
    let mut options = BTreeMap::new();
    while let Some(key) = args.next() {
        ensure!(key.starts_with("--"), "{USAGE}");
        let value = args.next().context(USAGE)?;
        ensure!(options.insert(key, value).is_none(), "duplicate option");
    }
    let key_path = take(&mut options, "--key")?;
    match command.as_str() {
        "keygen" => {
            no_extra(&options)?;
            let key = keygen(Path::new(&key_path))?;
            println!("{}", json!({"peerId": key.public().to_string()}));
        }
        "serve" => {
            let allowed: EndpointId = take(&mut options, "--allow-peer")?.parse()?;
            let node_id = take(&mut options, "--node-id")?;
            validate_node_id(&node_id)?;
            let listen = options
                .remove("--listen")
                .unwrap_or_else(|| "127.0.0.1:0".into())
                .parse()?;
            no_extra(&options)?;
            let endpoint = bind_loopback(read_key(Path::new(&key_path))?, listen).await?;
            println!(
                "{}",
                json!({"peerId":endpoint.id().to_string(), "nodeId":node_id, "addresses":endpoint.bound_sockets()})
            );
            std::io::stdout().flush()?;
            let result = tokio::select! {
                result = serve(&endpoint, allowed, &node_id) => result,
                result = tokio::signal::ctrl_c() => result.map_err(Into::into),
            };
            endpoint.close().await;
            result?;
        }
        "hello" => {
            let peer: EndpointId = take(&mut options, "--peer")?.parse()?;
            let address: SocketAddr = take(&mut options, "--address")?.parse()?;
            ensure!(
                address.ip().is_loopback(),
                "bootstrap target must be loopback"
            );
            let expected = take(&mut options, "--expect-node")?;
            no_extra(&options)?;
            let local = if address.is_ipv6() {
                "[::1]:0"
            } else {
                "127.0.0.1:0"
            };
            let endpoint = bind_loopback(read_key(Path::new(&key_path))?, local.parse()?).await?;
            let result = query_hello(
                &endpoint,
                EndpointAddr::new(peer).with_ip_addr(address),
                &expected,
            )
            .await;
            endpoint.close().await;
            println!("{}", serde_json::to_string(&result?)?);
        }
        _ => bail!("{USAGE}"),
    }
    Ok(())
}
