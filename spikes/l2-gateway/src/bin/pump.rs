//! Runner side: relays frames between QEMU's `-netdev dgram` unix socket and
//! the gateway. It has no IP stack and opens no other connection.
use anyhow::{Context, Result, bail};
use iroh::{EndpointAddr, EndpointId};
use l2_gateway_spike::{ALPN, Fragmenter, Reassembler, bind, load_key};
use std::{path::PathBuf, sync::Arc, sync::atomic::{AtomicU64, Ordering::Relaxed}};
use tokio::net::UnixDatagram;

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    let [_, key, gateway_id, gateway_addr, own_sock, qemu_sock] = &args[..] else {
        bail!("usage: pump <key> <gateway-id> <gateway-ip:port> <own.sock> <qemu.sock>");
    };
    let key = load_key(&PathBuf::from(key))?;
    let gateway: EndpointId = gateway_id.parse()?;
    let endpoint = bind(key, "127.0.0.1:0".parse()?, vec![]).await?;
    let conn = endpoint
        .connect(EndpointAddr::new(gateway).with_ip_addr(gateway_addr.parse()?), ALPN)
        .await
        .context("connect to gateway")?;
    eprintln!("pump: connected, max datagram {:?}", conn.max_datagram_size());

    let _ = std::fs::remove_file(own_sock);
    let sock = Arc::new(UnixDatagram::bind(own_sock)?);
    let qemu = PathBuf::from(qemu_sock);
    let dropped = Arc::new(AtomicU64::new(0));

    let up = {
        let (sock, conn, dropped) = (sock.clone(), conn.clone(), dropped.clone());
        tokio::spawn(async move {
            let mut buf = vec![0u8; 65536];
            let mut fragmenter = Fragmenter::default();
            loop {
                let n = sock.recv(&mut buf).await?;
                let max = conn.max_datagram_size().unwrap_or(1200);
                for d in fragmenter.split(&buf[..n], max) {
                    // Congested: drop, the guest's TCP retransmits.
                    if conn.send_datagram(d).is_err() && dropped.fetch_add(1, Relaxed) % 100 == 0 {
                        eprintln!("pump: dropped datagram ({n} byte frame)");
                    }
                }
            }
            #[allow(unreachable_code)]
            anyhow::Ok(())
        })
    };
    let mut reassembler = Reassembler::default();
    loop {
        let datagram = conn.read_datagram().await.context("gateway closed")?;
        let Some(frame) = reassembler.push(datagram) else { continue };
        // QEMU may not have bound its socket yet during boot.
        let _ = sock.send_to(&frame, &qemu).await;
        if up.is_finished() {
            break;
        }
    }
    up.await??;
    Ok(())
}
