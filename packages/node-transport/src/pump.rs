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
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, AtomicUsize, Ordering},
    },
    time::Duration,
};

use anyhow::Result;
use iroh::{EndpointId, endpoint::Connection};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::os::fd::{AsRawFd, OwnedFd, RawFd};
use tokio::{net::UnixDatagram, task::JoinHandle};

use crate::{
    diagnose::{now_ms, record_event},
    l2::{
        Fragmenter, FrameReady, Reassembler, accept_hello, answer_hello, constant_time_eq,
        send_frame,
    },
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

/// What one pump has carried since QEMU started, for `vm.diagnose`. A
/// frame from the guest shows its kernel brought the NIC up.
#[derive(Default)]
struct FrameStats {
    opened_at: u64,
    from_guest: AtomicU64,
    from_guest_bytes: AtomicU64,
    /// Frames from the guest while no gateway was connected.
    from_guest_dropped: AtomicU64,
    first_from_guest_at: AtomicU64,
    last_from_guest_at: AtomicU64,
    to_guest: AtomicU64,
    last_to_guest_at: AtomicU64,
    connections: AtomicU64,
    connected_at: AtomicU64,
    disconnected_at: AtomicU64,
    refusals: AtomicU64,
    last_refusal: Mutex<Option<(u64, &'static str)>>,
}

struct Pump {
    thread_id: String,
    grant: Mutex<FrameGrant>,
    current: Slot,
    socket: Arc<UnixDatagram>,
    reader: JoinHandle<()>,
    stats: Arc<FrameStats>,
    /// The VM directory, for its event log.
    dir: PathBuf,
}

impl Drop for Pump {
    fn drop(&mut self) {
        self.reader.abort();
        replace(&self.current, None);
    }
}

#[derive(Default)]
pub struct Pumps {
    pumps: Mutex<HashMap<String, Arc<Pump>>>,
    connections: AtomicUsize,
}

impl Pumps {
    /// Creates the frame socket pair and starts relaying what QEMU sends.
    /// Returns QEMU's end, inheritable across exec, for
    /// `-netdev dgram,local.type=fd`. Must run inside a Tokio runtime.
    pub fn open(
        &self,
        vm_id: &str,
        thread_id: &str,
        grant: FrameGrant,
        dir: PathBuf,
    ) -> Result<OwnedFd> {
        self.close(vm_id);
        let (ours, theirs) = std::os::unix::net::UnixDatagram::pair()?;
        // Both ends are ours to size: QEMU's default receive space is 4 KiB
        // on macOS, which held only two or three frames of a burst.
        enlarge_buffers(ours.as_raw_fd());
        enlarge_buffers(theirs.as_raw_fd());
        ours.set_nonblocking(true)?;
        let theirs = OwnedFd::from(theirs);
        // SAFETY: fcntl on a descriptor this process owns.
        unsafe {
            let flags = libc::fcntl(theirs.as_raw_fd(), libc::F_GETFD);
            if flags < 0
                || libc::fcntl(theirs.as_raw_fd(), libc::F_SETFD, flags & !libc::FD_CLOEXEC) < 0
            {
                return Err(std::io::Error::last_os_error().into());
            }
        }
        let socket = Arc::new(UnixDatagram::from_std(ours)?);
        let current: Slot = Arc::default();
        let stats = Arc::new(FrameStats {
            opened_at: now_ms(),
            ..FrameStats::default()
        });
        let reader = tokio::spawn(relay_from_qemu(
            socket.clone(),
            current.clone(),
            stats.clone(),
            dir.clone(),
        ));
        let pump = Arc::new(Pump {
            thread_id: thread_id.into(),
            grant: Mutex::new(grant),
            current,
            socket,
            reader,
            stats,
            dir,
        });
        self.pumps.lock().unwrap().insert(vm_id.into(), pump);
        Ok(theirs)
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

    /// A VM's frame channel as `vm.diagnose` reports it; None when the VM
    /// has no pump (its QEMU is not running under this process).
    pub fn observe(&self, vm_id: &str) -> Option<Value> {
        let pump = self.pumps.lock().unwrap().get(vm_id).cloned()?;
        let stats = &pump.stats;
        let count = |value: &AtomicU64| value.load(Ordering::Relaxed);
        let at = |value: &AtomicU64| match value.load(Ordering::Relaxed) {
            0 => Value::Null,
            ms => ms.into(),
        };
        let refusal = *stats.last_refusal.lock().unwrap();
        let connected = pump.current.lock().unwrap().is_some();
        Some(json!({
            "openedAt": stats.opened_at,
            "gatewayConnected": connected,
            "connections": count(&stats.connections),
            "connectedAt": at(&stats.connected_at),
            "disconnectedAt": at(&stats.disconnected_at),
            "refusals": count(&stats.refusals),
            "lastRefusal": refusal.map(|(at, reason)| json!({"at": at, "reason": reason})),
            "framesFromGuest": count(&stats.from_guest),
            "bytesFromGuest": count(&stats.from_guest_bytes),
            "framesFromGuestDropped": count(&stats.from_guest_dropped),
            "firstFrameFromGuestAt": at(&stats.first_from_guest_at),
            "lastFrameFromGuestAt": at(&stats.last_from_guest_at),
            "framesToGuest": count(&stats.to_guest),
            "lastFrameToGuestAt": at(&stats.last_to_guest_at),
        }))
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
            // Only the VM's own pump keeps the refusal; another thread's
            // gateway learns nothing about it.
            if let Some(pump) = pump.as_ref().filter(|p| p.thread_id == hello.thread_id) {
                pump.stats.refusals.fetch_add(1, Ordering::Relaxed);
                *pump.stats.last_refusal.lock().unwrap() = Some((now_ms(), reason));
                record_event(&pump.dir, "gateway refused", Some(reason));
            }
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
        pump.stats.connections.fetch_add(1, Ordering::Relaxed);
        pump.stats.connected_at.store(now_ms(), Ordering::Relaxed);
        record_event(&pump.dir, "gateway connected", None);
        let mut reassembler = Reassembler::default();
        while let Ok(datagram) = connection.read_datagram().await {
            if let Some(frame) = reassembler.push(datagram) {
                pump.stats.to_guest.fetch_add(1, Ordering::Relaxed);
                pump.stats
                    .last_to_guest_at
                    .store(now_ms(), Ordering::Relaxed);
                send_to_qemu(&pump.socket, &frame).await;
            }
        }
        pump.stats
            .disconnected_at
            .store(now_ms(), Ordering::Relaxed);
        let reason = connection.close_reason().map(|reason| reason.to_string());
        record_event(&pump.dir, "gateway disconnected", reason.as_deref());
        let mut current = pump.current.lock().unwrap();
        if current
            .as_ref()
            .is_some_and(|c| c.stable_id() == connection.stable_id())
        {
            *current = None;
        }
    }
}

/// Unix datagram buffers are tiny on macOS (`net.local.dgram.recvspace` is
/// 4 KiB). Ask for 4 MiB; the kernel caps it at its own limit.
fn enlarge_buffers(fd: RawFd) {
    const SIZE: libc::c_int = 4 << 20;
    for option in [libc::SO_SNDBUF, libc::SO_RCVBUF] {
        // SAFETY: plain setsockopt on a socket this process owns.
        unsafe {
            libc::setsockopt(
                fd,
                libc::SOL_SOCKET,
                option,
                (&SIZE as *const libc::c_int).cast(),
                std::mem::size_of::<libc::c_int>() as libc::socklen_t,
            );
        }
    }
}

/// When QEMU's receive buffer is still full macOS answers ENOBUFS instead of
/// blocking. Retry as backpressure: first by yielding (timer sleeps are at
/// least 1 ms, which capped a guest at ~3 MB/s), then briefly sleeping. A
/// frame that still does not fit is dropped; the guest's TCP retransmits.
async fn send_to_qemu(socket: &UnixDatagram, frame: &[u8]) {
    for attempt in 0..300u32 {
        match socket.send(frame).await {
            Ok(_) => return,
            Err(e) if e.raw_os_error() == Some(libc::ENOBUFS) => {
                if attempt < 250 {
                    tokio::task::yield_now().await;
                } else {
                    tokio::time::sleep(Duration::from_millis(1)).await;
                }
            }
            Err(_) => return,
        }
    }
}

async fn relay_from_qemu(
    socket: Arc<UnixDatagram>,
    current: Slot,
    stats: Arc<FrameStats>,
    dir: PathBuf,
) {
    let mut buffer = vec![0u8; 65536];
    let mut fragmenter = Fragmenter::default();
    loop {
        let Ok(n) = socket.recv(&mut buffer).await else {
            return;
        };
        let now = now_ms();
        stats.from_guest.fetch_add(1, Ordering::Relaxed);
        stats
            .from_guest_bytes
            .fetch_add(n as u64, Ordering::Relaxed);
        stats.last_from_guest_at.store(now, Ordering::Relaxed);
        if stats
            .first_from_guest_at
            .compare_exchange(0, now, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            record_event(&dir, "first frame from the guest", None);
        }
        let connection = current.lock().unwrap().clone();
        if let Some(connection) = connection {
            // Congested: this frame is dropped whole; the guest retransmits.
            let _ = send_frame(&connection, &mut fragmenter, &buffer[..n]);
        } else {
            stats.from_guest_dropped.fetch_add(1, Ordering::Relaxed);
        }
    }
}
