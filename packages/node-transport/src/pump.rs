//! Frame pump: a VM's `-netdev dgram` unix socket <-> `cube/l2/1` datagrams.
//!
//! The runner owns `net.sock`; QEMU owns `qemu-net.sock`. Frames from QEMU
//! go to the VM's current frame connection, fragmented; frames from the
//! gateway are reassembled and sent to QEMU. Without a connection frames
//! are dropped. The runner opens no other socket for the guest.
//!
//! Authorization comes from the latest accepted `vm.start`: it names the
//! gateway peer and a frame token, of which only the sha256 is kept. A new
//! grant closes the current connection.
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::Result;
use iroh::{EndpointId, endpoint::Connection};
use sha2::{Digest, Sha256};
use tokio::{net::UnixDatagram, task::JoinHandle};

use crate::l2::{
    Fragmenter, FrameReady, Reassembler, accept_hello, answer_hello, constant_time_eq,
};

pub const HELLO_TIMEOUT: Duration = Duration::from_secs(5);
/// Frame connections across all VMs, including ones still saying hello.
pub const MAX_FRAME_CONNECTIONS: usize = 32;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FrameGrant {
    pub peer: EndpointId,
    pub token_sha256: [u8; 32],
}

impl FrameGrant {
    pub fn new(peer: EndpointId, token: &str) -> Self {
        Self {
            peer,
            token_sha256: Sha256::digest(token.as_bytes()).into(),
        }
    }
}

/// The connection a VM's frames currently travel on.
type Slot = Arc<Mutex<Option<Connection>>>;

fn replace(slot: &Slot, connection: Option<Connection>) {
    let old = std::mem::replace(&mut *slot.lock().unwrap(), connection);
    if let Some(old) = old {
        old.close(0u32.into(), b"replaced");
    }
}

struct Pump {
    thread_id: String,
    grant: Mutex<FrameGrant>,
    current: Slot,
    socket: Arc<UnixDatagram>,
    qemu: PathBuf,
    net: PathBuf,
    reader: JoinHandle<()>,
}

impl Drop for Pump {
    fn drop(&mut self) {
        self.reader.abort();
        replace(&self.current, None);
        let _ = std::fs::remove_file(&self.net);
    }
}

#[derive(Default)]
pub struct Pumps {
    pumps: Mutex<HashMap<String, Arc<Pump>>>,
    connections: AtomicUsize,
}

impl Pumps {
    /// Binds `net` and starts relaying the frames QEMU sends from `qemu`.
    /// Must run inside a Tokio runtime.
    pub fn open(
        &self,
        vm_id: &str,
        thread_id: &str,
        net: &Path,
        qemu: &Path,
        grant: FrameGrant,
    ) -> Result<()> {
        self.close(vm_id);
        let _ = std::fs::remove_file(net);
        let socket = Arc::new(UnixDatagram::bind(net)?);
        let current: Slot = Arc::default();
        let reader = tokio::spawn(relay_from_qemu(socket.clone(), current.clone()));
        let pump = Arc::new(Pump {
            thread_id: thread_id.into(),
            grant: Mutex::new(grant),
            current,
            socket,
            qemu: qemu.into(),
            net: net.into(),
            reader,
        });
        self.pumps.lock().unwrap().insert(vm_id.into(), pump);
        Ok(())
    }

    /// Replaces the grant. A different token or peer closes the current
    /// frame connection; the gateway has to say hello again.
    pub fn authorize(&self, vm_id: &str, grant: FrameGrant) -> bool {
        let Some(pump) = self.pumps.lock().unwrap().get(vm_id).cloned() else {
            return false;
        };
        let mut current = pump.grant.lock().unwrap();
        if *current != grant {
            *current = grant;
            drop(current);
            replace(&pump.current, None);
        }
        true
    }

    pub fn close(&self, vm_id: &str) {
        let pump = self.pumps.lock().unwrap().remove(vm_id);
        drop(pump);
    }

    pub fn close_all(&self) {
        let pumps: Vec<_> = self.pumps.lock().unwrap().drain().collect();
        drop(pumps);
    }

    /// Cheap pre-filter before reading anything from a frame connection.
    pub fn knows_peer(&self, peer: EndpointId) -> bool {
        self.pumps
            .lock()
            .unwrap()
            .values()
            .any(|pump| pump.grant.lock().unwrap().peer == peer)
    }

    pub fn has_connection(&self, vm_id: &str) -> bool {
        self.pumps
            .lock()
            .unwrap()
            .get(vm_id)
            .is_some_and(|pump| pump.current.lock().unwrap().is_some())
    }

    /// Serves one accepted `cube/l2/1` connection until it closes or is
    /// replaced.
    pub async fn serve(self: Arc<Self>, connection: Connection) {
        if self.connections.fetch_add(1, Ordering::SeqCst) >= MAX_FRAME_CONNECTIONS {
            self.connections.fetch_sub(1, Ordering::SeqCst);
            connection.close(2u32.into(), b"BUSY");
            return;
        }
        self.serve_inner(connection).await;
        self.connections.fetch_sub(1, Ordering::SeqCst);
    }

    async fn serve_inner(&self, connection: Connection) {
        let peer = connection.remote_id();
        if !self.knows_peer(peer) {
            connection.close(1u32.into(), b"UNAUTHORIZED");
            return;
        }
        let Ok(Ok((hello, send))) =
            tokio::time::timeout(HELLO_TIMEOUT, accept_hello(&connection)).await
        else {
            connection.close(1u32.into(), b"INVALID_HELLO");
            return;
        };
        let pump = self.pumps.lock().unwrap().get(&hello.vm_id).cloned();
        let refusal = match &pump {
            None => Some("no running vm with that id"),
            Some(pump) if pump.thread_id != hello.thread_id => Some("no running vm with that id"),
            Some(pump) => {
                let grant = pump.grant.lock().unwrap().clone();
                let token: [u8; 32] = Sha256::digest(hello.frame_token.as_bytes()).into();
                if grant.peer != peer {
                    Some("peer is not this vm's gateway")
                } else if !constant_time_eq(&token, &grant.token_sha256) {
                    Some("frame token does not match")
                } else {
                    None
                }
            }
        };
        if let Some(reason) = refusal {
            let _ = answer_hello(send, &FrameReady::refused(reason)).await;
            // Give the answer a moment to reach the gateway, which closes.
            let _ = tokio::time::timeout(Duration::from_secs(2), connection.closed()).await;
            connection.close(1u32.into(), b"REFUSED");
            return;
        }
        let pump = pump.expect("checked above");
        if answer_hello(send, &FrameReady::accepted()).await.is_err() {
            return;
        }
        replace(&pump.current, Some(connection.clone()));
        let mut reassembler = Reassembler::default();
        while let Ok(datagram) = connection.read_datagram().await {
            if let Some(frame) = reassembler.push(datagram) {
                // QEMU may not have bound its socket yet during boot; a lost
                // frame is packet loss to the guest.
                let _ = pump.socket.send_to(&frame, &pump.qemu).await;
            }
        }
        let mut current = pump.current.lock().unwrap();
        if current
            .as_ref()
            .is_some_and(|c| c.stable_id() == connection.stable_id())
        {
            *current = None;
        }
    }
}

async fn relay_from_qemu(socket: Arc<UnixDatagram>, current: Slot) {
    let mut buffer = vec![0u8; 65536];
    let mut fragmenter = Fragmenter::default();
    loop {
        let Ok(n) = socket.recv(&mut buffer).await else {
            return;
        };
        let connection = current.lock().unwrap().clone();
        if let Some(connection) = connection
            && let Some(max) = connection.max_datagram_size()
        {
            for datagram in fragmenter.split(&buffer[..n], max) {
                // Congested: the datagram is dropped; the guest retransmits.
                let _ = connection.send_datagram(datagram);
            }
        }
    }
}
