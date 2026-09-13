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
use cube_node_transport::{
    NetworkMode, Request, Response, bind_client, bind_node, call,
    host::{Binding, ExecSpec, Host},
    intent::Intent,
    query_hello, serve, serve_host, validate_node_id,
};
use iroh::{EndpointAddr, EndpointId, SecretKey};
use serde_json::json;

const USAGE: &str = "usage:
  cube-node-transport keygen --key <new-private-file>
  cube-node-transport serve --key <private-file> --allow-peer <public-key> --node-id <node-id> [--listen 127.0.0.1:0]
  cube-node-transport hello --key <private-file> --peer <pinned-public-key> --address <ip:port> --expect-node <node-id>
  cube-node-transport host-init --key <private-file> --state <NEW-directory> --workspace <existing-directory> --allow-peer <public-key> --node-id <node-id> --thread-id <thread-id> --env <integer>
  cube-node-transport host-serve --key <private-file> --state <directory> [--listen 127.0.0.1:0]
  cube-node-transport prepare-exec --key <control-key> --intent <NEW-file> --peer <server-key> --expect-node <node-id> --env <integer> --command <shell-command> [--cwd .] [--timeout-ms 10000] [--output-limit 8192]
  cube-node-transport submit --key <control-key> --intent <file> --address <ip:port>
  cube-node-transport operation --key <control-key> --intent <file> --address <ip:port>
network commands accept --network loopback|direct (default loopback); direct mode requires explicit interface/target addresses";

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
    let network = match options.remove("--network").as_deref() {
        None | Some("loopback") => NetworkMode::Loopback,
        Some("direct") => NetworkMode::Direct,
        _ => bail!("invalid network mode"),
    };
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
            let listen = if network == NetworkMode::Direct {
                take(&mut options, "--listen")?
            } else {
                options
                    .remove("--listen")
                    .unwrap_or_else(|| "127.0.0.1:0".into())
            }
            .parse()?;
            no_extra(&options)?;
            let endpoint = bind_node(read_key(Path::new(&key_path))?, listen, network).await?;
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
        "host-init" => {
            let state = take(&mut options, "--state")?;
            let workspace = take(&mut options, "--workspace")?;
            let allowed: EndpointId = take(&mut options, "--allow-peer")?.parse()?;
            let node_id = take(&mut options, "--node-id")?;
            let thread_id = take(&mut options, "--thread-id")?;
            let environment_id = take(&mut options, "--env")?.parse()?;
            no_extra(&options)?;
            let key = read_key(Path::new(&key_path))?;
            Host::initialize(
                Path::new(&state),
                Binding {
                    thread_id,
                    environment_id,
                    node_id,
                },
                key.public(),
                allowed,
                Path::new(&workspace),
            )?;
            println!("{}", json!({"initialized": true}));
        }
        "host-serve" => {
            let state = take(&mut options, "--state")?;
            let listen = if network == NetworkMode::Direct {
                take(&mut options, "--listen")?
            } else {
                options
                    .remove("--listen")
                    .unwrap_or_else(|| "127.0.0.1:0".into())
            }
            .parse()?;
            no_extra(&options)?;
            let key = read_key(Path::new(&key_path))?;
            let host = Host::open(Path::new(&state), key.public())?;
            let allowed = host.installation().allowed_peer.parse()?;
            let node_id = host.installation().binding.node_id.clone();
            eprintln!(
                "trusted host execution enabled: no sandbox; same OS account; do not use an account with control-plane credentials"
            );
            let endpoint = bind_node(key, listen, network).await?;
            println!(
                "{}",
                json!({"peerId":endpoint.id().to_string(), "nodeId":node_id, "addresses":endpoint.bound_sockets()})
            );
            std::io::stdout().flush()?;
            let result = tokio::select! {
                result = serve_host(&endpoint, allowed, &node_id, Some(host.clone())) => result,
                result = tokio::signal::ctrl_c() => result.map_err(Into::into),
            };
            endpoint.close().await;
            host.shutdown().await;
            result?;
        }
        "prepare-exec" => {
            let intent_path = take(&mut options, "--intent")?;
            let server = take(&mut options, "--peer")?.parse()?;
            let node_id = take(&mut options, "--expect-node")?;
            let env = take(&mut options, "--env")?.parse()?;
            let command = take(&mut options, "--command")?;
            let guest_cwd = options.remove("--cwd").unwrap_or_else(|| ".".into());
            let timeout_ms = options
                .remove("--timeout-ms")
                .unwrap_or_else(|| "10000".into())
                .parse()?;
            let output_limit = options
                .remove("--output-limit")
                .unwrap_or_else(|| "8192".into())
                .parse()?;
            no_extra(&options)?;
            let control = read_key(Path::new(&key_path))?.public();
            let intent = Intent::prepare(
                Path::new(&intent_path),
                node_id,
                env,
                server,
                control,
                ExecSpec {
                    command,
                    guest_cwd,
                    timeout_ms,
                    output_limit,
                },
            )?;
            println!("{}", json!({"operationId":intent.operation_id}));
        }
        "submit" | "operation" => {
            let intent_path = take(&mut options, "--intent")?;
            let address: SocketAddr = take(&mut options, "--address")?.parse()?;
            cube_node_transport::validate_target(address, network)?;
            no_extra(&options)?;
            let intent = Intent::load(Path::new(&intent_path))?;
            let key = read_key(Path::new(&key_path))?;
            ensure!(
                key.public().to_string() == intent.control_peer,
                "intent belongs to another control peer"
            );
            let query = if command == "submit" {
                // Persist consumed BEFORE the first possible network dispatch.
                // A failed dial also stays consumed; there is no automatic retry.
                Intent::consume(Path::new(&intent_path))?;
                Request::ExecStart {
                    env: intent.environment_id,
                    operation_id: intent.operation_id,
                    spec: intent.spec,
                }
            } else {
                Request::OperationGet {
                    env: intent.environment_id,
                    operation_id: intent.operation_id,
                }
            };
            let endpoint = bind_client(key, address, network).await?;
            let destination = EndpointAddr::new(intent.server_peer.parse()?).with_ip_addr(address);
            let response = if let Some(thread_id) = intent.thread_id {
                cube_node_transport::call_bound(
                    &endpoint,
                    destination,
                    &Binding {
                        thread_id,
                        node_id: intent.node_id,
                        environment_id: intent.environment_id,
                    },
                    &query,
                )
                .await
            } else {
                call(&endpoint, destination, &intent.node_id, &query).await
            };
            endpoint.close().await;
            let response = response?;
            println!("{}", serde_json::to_string(&response)?);
            ensure!(
                !matches!(response, Response::Error { .. }),
                "host request rejected; inspect response"
            );
        }
        "hello" => {
            let peer: EndpointId = take(&mut options, "--peer")?.parse()?;
            let address: SocketAddr = take(&mut options, "--address")?.parse()?;
            cube_node_transport::validate_target(address, network)?;
            let expected = take(&mut options, "--expect-node")?;
            no_extra(&options)?;
            let endpoint = bind_client(read_key(Path::new(&key_path))?, address, network).await?;
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
