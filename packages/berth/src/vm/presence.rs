//! Whether cubed is connected to the runner, and since when it is not
//! (masterplan B5, B-4 decision 2): ordinary egress goes on for a machine's
//! `policy.lease` after the last connection from cubed is gone, then new
//! flows and requests are refused and open flows' upstreams closed (their
//! guest side drains; egress.rs); the next connection ends the grace. The clock is the runner's own, started when the connection falls;
//! cubed renews nothing. Before cubed's first connection the runner counts
//! as left alone since it started (it has no running machine then).
//!
//! The addresses cubed is reached at (B-4 decision 3): the remote address
//! of every direct IP path Iroh has for a connection from cubed, read
//! again at every egress decision and remembered for the runner's life, so
//! a guest cannot reach cubed through the runner also after it left. Over a
//! relay-only connection the runner sees only the relay, so this is a
//! second layer behind `deny_hosts` and cubed being private.
use std::{
    collections::{BTreeMap, HashSet},
    net::IpAddr,
    sync::{Arc, Mutex},
    time::Duration,
};

use iroh::{TransportAddr, endpoint::Connection};
use tokio::{sync::watch, time::Instant};

/// At most this many remembered addresses of cubed (oldest first out).
const REMEMBERED: usize = 64;

#[derive(Clone, Copy, Debug)]
pub struct Cubed {
    pub connections: usize,
    /// When the last connection went (or the runner started).
    pub gone_since: Instant,
}

impl Cubed {
    /// When ordinary egress with `lease` ends; None while cubed is here.
    pub fn lease_end(&self, lease: Duration) -> Option<Instant> {
        (self.connections == 0).then(|| self.gone_since + lease)
    }
    pub fn expired(&self, lease: Duration) -> bool {
        self.lease_end(lease)
            .is_some_and(|end| Instant::now() >= end)
    }
}

pub struct Presence {
    state: watch::Sender<Cubed>,
    live: Mutex<BTreeMap<u64, Option<Connection>>>,
    next: Mutex<u64>,
    /// Every address cubed was reached at, in the order first seen.
    seen: Mutex<Vec<IpAddr>>,
}

impl Presence {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            state: watch::Sender::new(Cubed {
                connections: 0,
                gone_since: Instant::now(),
            }),
            live: Mutex::default(),
            next: Mutex::new(0),
            seen: Mutex::default(),
        })
    }

    pub fn now(&self) -> Cubed {
        *self.state.borrow()
    }

    pub fn subscribe(&self) -> watch::Receiver<Cubed> {
        self.state.subscribe()
    }

    /// cubed is connected while the guard lives. `connection` gives its
    /// paths (None: a test without Iroh).
    pub fn attach(self: &Arc<Self>, connection: Option<Connection>) -> Attached {
        let id = {
            let mut next = self.next.lock().unwrap();
            *next += 1;
            *next
        };
        if let Some(connection) = &connection {
            self.remember(connection);
        }
        let connections = {
            let mut live = self.live.lock().unwrap();
            live.insert(id, connection);
            live.len()
        };
        self.state
            .send_modify(|state| state.connections = connections);
        Attached {
            presence: Arc::clone(self),
            id,
        }
    }

    fn remember(&self, connection: &Connection) {
        let paths = connection.paths();
        let mut seen = self.seen.lock().unwrap();
        for path in paths.iter() {
            if let TransportAddr::Ip(address) = path.remote_addr() {
                let ip = address.ip().to_canonical();
                if !seen.contains(&ip) {
                    if seen.len() >= REMEMBERED {
                        seen.remove(0);
                    }
                    seen.push(ip);
                }
            }
        }
    }

    /// The addresses cubed is or was reached at, read fresh from the live
    /// connections' paths.
    pub fn cubed_addresses(&self) -> HashSet<IpAddr> {
        let live: Vec<Connection> = self
            .live
            .lock()
            .unwrap()
            .values()
            .flatten()
            .cloned()
            .collect();
        for connection in &live {
            self.remember(connection);
        }
        self.seen.lock().unwrap().iter().copied().collect()
    }

    /// Adds an address as if a path to cubed had it (tests).
    #[cfg(test)]
    pub fn note_address(&self, ip: IpAddr) {
        self.seen.lock().unwrap().push(ip);
    }
}

/// One live connection from cubed.
pub struct Attached {
    presence: Arc<Presence>,
    id: u64,
}

impl Drop for Attached {
    fn drop(&mut self) {
        let connections = {
            let mut live = self.presence.live.lock().unwrap();
            if let Some(Some(connection)) = live.remove(&self.id) {
                self.presence.remember(&connection);
            }
            live.len()
        };
        self.presence.state.send_modify(|state| {
            state.connections = connections;
            if connections == 0 {
                state.gone_since = Instant::now();
            }
        });
    }
}

/// Resolves once ordinary egress under the lease `lease()` may run again:
/// cubed is back (or the lease, read again at every change, covers the time
/// it has been gone). A runner that drops its presence never resolves it.
pub async fn lease_restored(mut cubed: watch::Receiver<Cubed>, lease: impl Fn() -> Duration) {
    loop {
        if !cubed.borrow_and_update().expired(lease()) {
            return;
        }
        if cubed.changed().await.is_err() {
            std::future::pending::<()>().await;
        }
    }
}

/// Resolves once ordinary egress under the lease `lease()` (read again at
/// every change) has run out: cubed gone for that long. A runner that
/// drops its presence counts as gone.
pub async fn lease_runs_out(mut cubed: watch::Receiver<Cubed>, lease: impl Fn() -> Duration) {
    loop {
        let state = *cubed.borrow_and_update();
        match state.lease_end(lease()) {
            None => {
                if cubed.changed().await.is_err() {
                    return;
                }
            }
            Some(end) => {
                tokio::select! {
                    _ = tokio::time::sleep_until(end) => {
                        if cubed.borrow().expired(lease()) {
                            return;
                        }
                    }
                    changed = cubed.changed() => if changed.is_err() { return },
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test(start_paused = true)]
    async fn the_grace_starts_when_the_last_connection_goes_and_ends_with_the_next() {
        let presence = Presence::new();
        let lease = Duration::from_secs(900);
        // Alone since the start: a machine started now would be past it at once
        // with lease 0, within it for 15 minutes otherwise.
        assert!(presence.now().expired(Duration::ZERO));
        assert!(!presence.now().expired(lease));
        let first = presence.attach(None);
        let second = presence.attach(None);
        tokio::time::advance(Duration::from_secs(3600)).await;
        assert!(!presence.now().expired(Duration::ZERO), "cubed is here");
        drop(first);
        assert!(
            !presence.now().expired(Duration::ZERO),
            "one connection is left"
        );
        drop(second);
        let runs_out = tokio::spawn(lease_runs_out(presence.subscribe(), move || lease));
        tokio::time::advance(Duration::from_secs(899)).await;
        assert!(!presence.now().expired(lease));
        assert!(!runs_out.is_finished());
        // cubed comes back before the end: the grace is over, nothing runs out.
        let back = presence.attach(None);
        tokio::time::advance(Duration::from_secs(3600)).await;
        tokio::task::yield_now().await;
        assert!(!runs_out.is_finished());
        drop(back);
        tokio::time::advance(Duration::from_secs(899)).await;
        tokio::task::yield_now().await;
        assert!(
            !runs_out.is_finished(),
            "a new grace started with the new loss"
        );
        tokio::time::advance(Duration::from_secs(2)).await;
        tokio::time::timeout(Duration::from_secs(1), runs_out)
            .await
            .expect("the lease ran out")
            .unwrap();
        assert!(presence.now().expired(lease));
    }

    #[tokio::test(start_paused = true)]
    async fn a_lease_of_zero_runs_out_when_cubed_goes() {
        let presence = Presence::new();
        let here = presence.attach(None);
        let runs_out = tokio::spawn(lease_runs_out(presence.subscribe(), || Duration::ZERO));
        tokio::time::advance(Duration::from_secs(60)).await;
        tokio::task::yield_now().await;
        assert!(!runs_out.is_finished());
        drop(here);
        tokio::time::timeout(Duration::from_millis(10), runs_out)
            .await
            .expect("at once")
            .unwrap();
    }
}
