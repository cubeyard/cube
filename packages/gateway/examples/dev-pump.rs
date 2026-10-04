//! Development stand-in for the runner's frame pump, for manual runs before
//! the runner speaks protocol 3. It accepts `cube/l2/1` from one gateway
//! peer, checks the hello like the runner will, and bridges frames to a QEMU
//! `-netdev dgram` unix socket. Prints its endpoint id and address.
//!
//! cargo run --release -p cube-gateway --example dev-pump -- \
//!   --key pump.key --listen 127.0.0.1:47011 --gateway <peer> \
//!   --vm <vmId> --thread <threadId> --token <64 hex> \
//!   --own pump.sock --qemu qemu.sock
use anyhow::{Context, Result, bail};
use cube_node_transport::l2::{
    Fragmenter, FrameReady, L2_ALPN, Reassembler, accept_hello, answer_hello, constant_time_eq,
};
use iroh::{Endpoint, EndpointId, endpoint::Connection, endpoint::presets};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Arc, Mutex},
};
use tokio::net::UnixDatagram;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mut options = HashMap::new();
    for pair in args.chunks(2) {
        let [key, value] = pair else {
            bail!("options take values")
        };
        options.insert(key.trim_start_matches("--").to_string(), value.clone());
    }
    let get = |k: &str| {
        options
            .get(k)
            .cloned()
            .with_context(|| format!("missing --{k}"))
    };
    let key = cube_gateway::load_or_create_key(&PathBuf::from(get("key")?))?;
    let gateway: EndpointId = get("gateway")?.parse()?;
    let (vm, thread, token) = (get("vm")?, get("thread")?, get("token")?);
    let (own, qemu) = (PathBuf::from(get("own")?), PathBuf::from(get("qemu")?));
    let endpoint = Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .alpns(vec![L2_ALPN.to_vec()])
        .clear_ip_transports()
        .clear_relay_transports()
        .clear_address_lookup()
        .bind_addr(get("listen")?.parse::<std::net::SocketAddr>()?)?
        .bind()
        .await?;
    println!("{}", endpoint.id());

    let _ = std::fs::remove_file(&own);
    let socket = Arc::new(UnixDatagram::bind(&own)?);
    let current: Arc<Mutex<Option<Connection>>> = Arc::new(Mutex::new(None));
    {
        let (socket, current) = (socket.clone(), current.clone());
        tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            let mut fragmenter = Fragmenter::default();
            loop {
                let Ok(n) = socket.recv(&mut buf).await else {
                    return;
                };
                let connection = current.lock().unwrap().clone();
                if let Some(c) = connection {
                    for d in fragmenter.split(&buf[..n], c.max_datagram_size().unwrap_or(1200)) {
                        let _ = c.send_datagram(d);
                    }
                }
            }
        });
    }
    while let Some(incoming) = endpoint.accept().await {
        let Ok(connection) = incoming.await else {
            continue;
        };
        let Ok((hello, send)) = accept_hello(&connection).await else {
            continue;
        };
        let refusal = if connection.remote_id() != gateway {
            Some("peer is not the gateway")
        } else if hello.vm_id != vm || hello.thread_id != thread {
            Some("no running vm with that id")
        } else if !constant_time_eq(hello.frame_token.as_bytes(), token.as_bytes()) {
            Some("frame token does not match")
        } else {
            None
        };
        if let Some(reason) = refusal {
            eprintln!("dev-pump: refused: {reason}");
            let _ = answer_hello(send, &FrameReady::refused(reason)).await;
            continue;
        }
        answer_hello(send, &FrameReady::accepted()).await?;
        eprintln!("dev-pump: gateway connected");
        if let Some(old) = current.lock().unwrap().replace(connection.clone()) {
            old.close(0u32.into(), b"replaced");
        }
        let (socket, qemu) = (socket.clone(), qemu.clone());
        tokio::spawn(async move {
            let mut reassembler = Reassembler::default();
            while let Ok(d) = connection.read_datagram().await {
                if let Some(frame) = reassembler.push(d) {
                    // QEMU may not have bound its socket yet during boot.
                    let _ = socket.send_to(&frame, &qemu).await;
                }
            }
            eprintln!("dev-pump: gateway connection closed");
        });
    }
    Ok(())
}
