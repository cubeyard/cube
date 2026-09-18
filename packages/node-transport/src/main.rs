//! Explicit development CLI. Key files contain secrets; stdout only contains
//! public identities, listener addresses and the hello response.
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    net::SocketAddr,
    path::{Path, PathBuf},
};

use anyhow::{Context, Result, bail, ensure};
use cube_node_transport::{
    MIN_COMPATIBLE_PROTOCOL_VERSION, NetworkMode, PROTOCOL_VERSION, Request, Response,
    SOFTWARE_VERSION, bind_client, bind_node, bind_relay_client, bind_relay_node, call,
    intent::Intent,
    query_hello,
    runner::{Binding, ExecSpec, Runner},
    serve, serve_runner, validate_node_id,
};
use iroh::{Endpoint, EndpointAddr, EndpointId, SecretKey};
use serde::{Deserialize, Serialize};
use serde_json::json;

const USAGE: &str = "usage:
  cube-runner init --home <NEW-directory> --workspace <existing-directory> --allow-peer <public-key> --node-id <node-id> --thread-id <thread-id> --env <integer> [--network loopback|direct|relay] [--listen <ip:port>]
  cube-runner run --home <directory> [--network loopback|direct|relay]
  cube-runner version
  cube-runner keygen --key <new-private-file>
  cube-runner serve --key <private-file> --allow-peer <public-key> --node-id <node-id> [--listen 127.0.0.1:0]
  cube-runner hello --key <private-file> --peer <pinned-public-key> --expect-node <node-id>
  cube-runner runner-init --key <private-file> --state <NEW-directory> --workspace <existing-directory> --allow-peer <public-key> --node-id <node-id> --thread-id <thread-id> --env <integer>
  cube-runner runner-acknowledge-recovery --key <private-file> --state <directory> --workspace <existing-directory>
  cube-runner runner-serve --key <private-file> --state <directory> [--listen 127.0.0.1:0] [--ready-file <absolute-file>] [--stop-policy wait|cancel]
  cube-runner prepare-exec --key <control-key> --intent <NEW-file> --peer <server-key> --expect-node <node-id> --env <integer> --command <shell-command> [--cwd .] [--timeout-ms 10000] [--output-limit 8192]
  cube-runner submit --key <control-key> --intent <file> [--address <ip:port>]
  cube-runner operation --key <control-key> --intent <file> [--address <ip:port>]
network commands accept --network loopback|direct|relay (default loopback); direct requires explicit addresses; relay uses N0 discovery and relays";

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DirectHome {
    version: u32,
    network: NetworkMode,
    listen: Option<String>,
}

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

async fn endpoint(
    key: SecretKey,
    network: NetworkMode,
    listen: Option<String>,
) -> Result<Endpoint> {
    if network == NetworkMode::Relay {
        ensure!(listen.is_none(), "relay mode does not accept --listen");
        bind_relay_node(key).await
    } else {
        let listen = if network == NetworkMode::Direct {
            listen.context("direct mode requires --listen")?
        } else {
            listen.unwrap_or_else(|| "127.0.0.1:0".into())
        };
        bind_node(key, listen.parse()?, network).await
    }
}

fn ready(endpoint: &Endpoint, node_id: &str, network: NetworkMode) -> serde_json::Value {
    let addr = endpoint.addr();
    json!({
        "peerId": endpoint.id().to_string(),
        "nodeId": node_id,
        "softwareVersion": SOFTWARE_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "minimumProtocolVersion": MIN_COMPATIBLE_PROTOCOL_VERSION,
        "lifecycle": "ready",
        "addresses": addr.ip_addrs().map(ToString::to_string).collect::<Vec<_>>(),
        "relayUrl": (network == NetworkMode::Relay).then(|| addr.relay_urls().next().map(ToString::to_string)).flatten(),
    })
}

fn write_ready(path: Option<&Path>, value: &serde_json::Value) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let Some(path) = path else { return Ok(()) };
    ensure!(path.is_absolute(), "ready file must be absolute");
    let parent = path.parent().context("ready file has no parent")?;
    let temporary = parent.join(format!(".ready.{}.tmp", std::process::id()));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o644)
        .open(&temporary)?;
    file.write_all(serde_json::to_string(value)?.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    fs::rename(&temporary, path)?;
    File::open(parent)?.sync_all()?;
    Ok(())
}

fn remove_ready(path: Option<&Path>) {
    if let Some(path) = path {
        let _ = fs::remove_file(path);
    }
}

fn write_direct_home(home: &Path, value: &DirectHome) -> Result<()> {
    use std::os::unix::fs::OpenOptionsExt;
    let path = home.join("runner.json");
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(path)?;
    file.write_all(serde_json::to_string_pretty(value)?.as_bytes())?;
    file.write_all(b"\n")?;
    file.sync_all()?;
    File::open(home)?.sync_all()?;
    Ok(())
}

fn read_direct_home(home: &Path) -> Result<DirectHome> {
    use std::os::unix::fs::MetadataExt;
    ensure!(home.is_absolute(), "--home must be absolute");
    let metadata = fs::symlink_metadata(home)?;
    ensure!(
        metadata.is_dir() && metadata.mode() & 0o077 == 0,
        "runner home must be a private directory, not a symlink"
    );
    let manifest: DirectHome = serde_json::from_slice(&fs::read(home.join("runner.json"))?)?;
    ensure!(manifest.version == 1, "unsupported runner home version");
    Ok(manifest)
}

async fn client_destination(
    options: &mut BTreeMap<String, String>,
    key: SecretKey,
    peer: EndpointId,
    network: NetworkMode,
) -> Result<(Endpoint, EndpointAddr)> {
    if network == NetworkMode::Relay {
        ensure!(
            !options.contains_key("--address"),
            "relay mode does not accept --address"
        );
        Ok((bind_relay_client(key).await?, EndpointAddr::new(peer)))
    } else {
        let address: SocketAddr = take(options, "--address")?.parse()?;
        cube_node_transport::validate_target(address, network)?;
        Ok((
            bind_client(key, address, network).await?,
            EndpointAddr::new(peer).with_ip_addr(address),
        ))
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let mut args = std::env::args().skip(1);
    let command = args.next().context(USAGE)?;
    if command == "--help" || command == "help" {
        ensure!(args.next().is_none(), "{USAGE}");
        println!("{USAGE}");
        return Ok(());
    }
    let mut options = BTreeMap::new();
    while let Some(key) = args.next() {
        ensure!(key.starts_with("--"), "{USAGE}");
        let value = args.next().context(USAGE)?;
        ensure!(options.insert(key, value).is_none(), "duplicate option");
    }
    if command == "version" {
        no_extra(&options)?;
        println!(
            "{}",
            json!({
                "softwareVersion": SOFTWARE_VERSION,
                "protocolVersion": PROTOCOL_VERSION,
                "minimumProtocolVersion": MIN_COMPATIBLE_PROTOCOL_VERSION,
            })
        );
        return Ok(());
    }
    let network_option = match options.remove("--network").as_deref() {
        None => None,
        Some("loopback") => Some(NetworkMode::Loopback),
        Some("direct") => Some(NetworkMode::Direct),
        Some("relay") => Some(NetworkMode::Relay),
        _ => bail!("invalid network mode"),
    };
    let direct_home = matches!(command.as_str(), "init" | "run")
        .then(|| take(&mut options, "--home"))
        .transpose()?
        .map(PathBuf::from);
    let key_path = if let Some(home) = &direct_home {
        home.join("runner.key")
    } else {
        PathBuf::from(take(&mut options, "--key")?)
    };
    match command.as_str() {
        "keygen" => {
            no_extra(&options)?;
            let key = keygen(&key_path)?;
            println!("{}", json!({"peerId": key.public().to_string()}));
        }
        "serve" => {
            let allowed: EndpointId = take(&mut options, "--allow-peer")?.parse()?;
            let node_id = take(&mut options, "--node-id")?;
            validate_node_id(&node_id)?;
            let listen = options.remove("--listen");
            no_extra(&options)?;
            let network = network_option.unwrap_or_default();
            let endpoint = endpoint(read_key(&key_path)?, network, listen).await?;
            println!("{}", ready(&endpoint, &node_id, network));
            std::io::stdout().flush()?;
            let result = tokio::select! {
                result = serve(&endpoint, allowed, &node_id) => result,
                result = tokio::signal::ctrl_c() => result.map_err(Into::into),
            };
            endpoint.close().await;
            result?;
        }
        "init" | "runner-init" | "host-init" => {
            if command == "host-init" {
                eprintln!("cube-runner: host-init is deprecated; use runner-init");
            }
            let state = if direct_home.is_some() {
                None
            } else {
                Some(take(&mut options, "--state")?)
            };
            let workspace = take(&mut options, "--workspace")?;
            let allowed: EndpointId = take(&mut options, "--allow-peer")?.parse()?;
            let node_id = take(&mut options, "--node-id")?;
            let thread_id = take(&mut options, "--thread-id")?;
            let environment_id = take(&mut options, "--env")?.parse()?;
            let listen = options.remove("--listen");
            no_extra(&options)?;
            let home = direct_home.as_deref();
            let network = network_option.unwrap_or_default();
            if network == NetworkMode::Relay {
                ensure!(listen.is_none(), "relay mode does not accept --listen");
            } else if network == NetworkMode::Direct {
                ensure!(listen.is_some(), "direct mode requires --listen");
            }
            if let Some(home) = home {
                use std::os::unix::fs::DirBuilderExt;
                ensure!(home.is_absolute(), "--home must be absolute");
                let mut builder = fs::DirBuilder::new();
                builder.mode(0o700).create(home)?;
            } else {
                ensure!(listen.is_none(), "runner-init does not accept --listen");
            }
            let key = if home.is_some() {
                keygen(&key_path)?
            } else {
                read_key(&key_path)?
            };
            let state = home.map_or_else(
                || PathBuf::from(state.as_ref().unwrap()),
                |home| home.join("state"),
            );
            let display_node = node_id.clone();
            Runner::initialize(
                &state,
                Binding {
                    thread_id,
                    environment_id,
                    node_id,
                },
                key.public(),
                allowed,
                Path::new(&workspace),
            )?;
            if let Some(home) = home {
                write_direct_home(
                    home,
                    &DirectHome {
                        version: 1,
                        network,
                        listen,
                    },
                )?;
                println!("cube-runner {SOFTWARE_VERSION}");
                println!("initialized: {}", home.display());
                println!("node: {display_node}");
                println!("peer: {}", key.public());
                println!(
                    "network: {}",
                    match network {
                        NetworkMode::Loopback => "loopback",
                        NetworkMode::Direct => "direct",
                        NetworkMode::Relay => "relay",
                    }
                );
                println!("next: cube-runner run --home {}", home.display());
            } else {
                println!("{}", json!({"initialized": true}));
            }
        }
        "runner-acknowledge-recovery" => {
            let state = take(&mut options, "--state")?;
            let workspace = take(&mut options, "--workspace")?;
            no_extra(&options)?;
            let key = read_key(&key_path)?;
            Runner::acknowledge_recovery(Path::new(&state), key.public(), Path::new(&workspace))?;
            println!("{}", json!({"recoveryAcknowledged": true}));
        }
        "run" | "runner-serve" | "host-serve" => {
            if command == "host-serve" {
                eprintln!("cube-runner: host-serve is deprecated; use runner-serve");
            }
            let human = command == "run";
            let manifest = direct_home.as_deref().map(read_direct_home).transpose()?;
            let state = manifest.as_ref().map_or_else(
                || take(&mut options, "--state").map(PathBuf::from),
                |_| Ok(direct_home.as_ref().unwrap().join("state")),
            )?;
            let listen = manifest
                .as_ref()
                .and_then(|manifest| manifest.listen.clone())
                .or_else(|| options.remove("--listen"));
            let network = network_option
                .or_else(|| manifest.as_ref().map(|manifest| manifest.network))
                .unwrap_or_default();
            let ready_file = options.remove("--ready-file").map(PathBuf::from);
            let cancel_on_stop = match options.remove("--stop-policy").as_deref() {
                None | Some("wait") => false,
                Some("cancel") => true,
                Some(_) => bail!("invalid stop policy"),
            };
            if human {
                ensure!(ready_file.is_none(), "run does not accept --ready-file");
                ensure!(
                    !cancel_on_stop,
                    "run uses two-stage Ctrl-C; --stop-policy cancel belongs to runner-serve"
                );
            }
            no_extra(&options)?;
            let key = read_key(&key_path)?;
            let runner = Runner::open(&state, key.public())?;
            let allowed = runner.installation().allowed_peer.parse()?;
            let node_id = runner.installation().binding.node_id.clone();
            eprintln!(
                "{{\"level\":\"info\",\"event\":\"runner_starting\",\"trust\":\"same-uid-not-sandboxed\"}}"
            );
            let endpoint = endpoint(key, network, listen).await?;
            let mut readiness = ready(&endpoint, &node_id, network);
            readiness["lifecycle"] = json!(runner.status()?.lifecycle);
            if human {
                eprintln!("cube-runner {SOFTWARE_VERSION}");
                eprintln!("node: {node_id}");
                eprintln!(
                    "peer: {}",
                    readiness["peerId"].as_str().unwrap_or("unknown")
                );
                eprintln!("network ready / waiting for cubed");
                if let Some(addresses) = readiness["addresses"].as_array() {
                    let addresses = addresses
                        .iter()
                        .filter_map(|value| value.as_str())
                        .collect::<Vec<_>>()
                        .join(", ");
                    if !addresses.is_empty() {
                        eprintln!("listen: {addresses}");
                    }
                }
                eprintln!(
                    "lifecycle: {}",
                    readiness["lifecycle"].as_str().unwrap_or("unknown")
                );
                eprintln!("press Ctrl-C to drain and stop");
            } else {
                println!("{readiness}");
                std::io::stdout().flush()?;
            }
            write_ready(ready_file.as_deref(), &readiness)?;
            use tokio::signal::unix::{SignalKind, signal};
            let mut interrupt = signal(SignalKind::interrupt())?;
            let mut terminate = signal(SignalKind::terminate())?;
            let mut drain = signal(SignalKind::user_defined1())?;
            let mut resume = signal(SignalKind::user_defined2())?;
            let result = {
                let server = serve_runner(&endpoint, allowed, &node_id, Some(runner.clone()));
                tokio::pin!(server);
                loop {
                    tokio::select! {
                        result = &mut server => break result,
                        _ = interrupt.recv() => break Ok(()),
                        _ = terminate.recv() => break Ok(()),
                        _ = drain.recv() => {
                            runner.drain();
                            readiness["lifecycle"] = json!("draining");
                            write_ready(ready_file.as_deref(), &readiness)?;
                            eprintln!("{{\"level\":\"info\",\"event\":\"runner_draining\"}}");
                        },
                        _ = resume.recv() => {
                            if runner.resume().is_ok() {
                                readiness["lifecycle"] = json!("ready");
                                write_ready(ready_file.as_deref(), &readiness)?;
                                eprintln!("{{\"level\":\"info\",\"event\":\"runner_ready\"}}");
                            } else {
                                eprintln!("{{\"level\":\"warn\",\"event\":\"runner_resume_refused\",\"action\":\"stop and complete recovery\"}}");
                            }
                        },
                    }
                }
            };
            runner.drain();
            readiness["lifecycle"] = json!("draining");
            write_ready(ready_file.as_deref(), &readiness)?;
            let active = runner.status()?.active;
            if human {
                if active {
                    eprintln!("stopping: draining; waiting for the active command (up to 60s)");
                    eprintln!("press Ctrl-C again to cancel it");
                } else {
                    eprintln!("stopping: drained; no active command");
                }
            } else {
                eprintln!(
                    "{{\"level\":\"info\",\"event\":\"runner_stopping\",\"active\":{active}}}"
                );
            }
            if cancel_on_stop {
                runner.shutdown(true).await;
            } else {
                let graceful = runner.shutdown(false);
                tokio::pin!(graceful);
                tokio::select! {
                    _ = &mut graceful => {},
                    _ = interrupt.recv() => {
                        if human { eprintln!("cancelling: active command"); }
                        else { eprintln!("{{\"level\":\"warn\",\"event\":\"runner_cancelling_active\"}}"); }
                        runner.shutdown(true).await;
                    },
                    _ = terminate.recv() => {
                        runner.shutdown(true).await;
                    },
                }
            }
            endpoint.close().await;
            remove_ready(ready_file.as_deref());
            if human {
                eprintln!("stopped");
            }
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
            let (endpoint, destination) = client_destination(
                &mut options,
                key,
                intent.server_peer.parse()?,
                network_option.unwrap_or_default(),
            )
            .await?;
            no_extra(&options)?;
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
                "runner request rejected; inspect response"
            );
        }
        "hello" => {
            let peer: EndpointId = take(&mut options, "--peer")?.parse()?;
            let expected = take(&mut options, "--expect-node")?;
            let (endpoint, destination) = client_destination(
                &mut options,
                read_key(&key_path)?,
                peer,
                network_option.unwrap_or_default(),
            )
            .await?;
            no_extra(&options)?;
            let result = query_hello(&endpoint, destination, &expected).await;
            endpoint.close().await;
            println!("{}", serde_json::to_string(&result?)?);
        }
        _ => bail!("{USAGE}"),
    }
    Ok(())
}
