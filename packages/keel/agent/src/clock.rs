//! The machine's `CLOCK_REALTIME`, kept in step with the host's all the
//! time (keel plan, "Guest bring-up"), so a resume needs no message for
//! time: the guest's clocks stop while it is paused or saved, and the next
//! sync puts realtime right. The host's clock is a PTP clock picked by its
//! name, not its number: virtio-rtc's "Virtio PTP" (keel's QEMU arguments
//! carry `virtio-rtc-pci`; type 0 is UTC), else KVM's "KVM virtual PTP".
//! Both read the host's realtime clock.
//!
//! Two callers sync: the clock thread every INTERVAL and `sync_now` before
//! every hello. Each once stepped by the offset it had read, so a step by
//! the other between its reads was added twice (a restore's +3.6 s step,
//! then +1.8 s more from the stale reads). Now a sync holds SYNC from its
//! first read to its step, and steps to the host's reading plus the
//! monotonic time since it, which no realtime step changes. The agent is
//! the only thing in the machine that sets realtime.
use std::{
    fs, io,
    os::fd::AsRawFd,
    sync::{Mutex, TryLockError},
    time::Duration,
};

/// How often the clock is compared. Realtime is right within this (plus a
/// read) after a resume.
pub const INTERVAL: Duration = Duration::from_millis(500);
/// A smaller offset is left alone (reading the PTP clock costs a few µs
/// under KVM, a few ms under TCG).
const STEP_NS: i128 = 20_000_000;
/// One sync at a time, whoever calls it. A sync is a few clock reads and
/// a `clock_settime`, so a wait for the other caller is that long.
static SYNC: Mutex<()> = Mutex::new(());
/// Preferred first.
const NAMES: [&str; 2] = ["Virtio PTP", "KVM virtual PTP"];

/// The host's clock: the open PTP device and its name.
pub struct Source {
    device: fs::File,
    pub name: String,
    pub path: String,
}

/// The PTP clock to follow, by `/sys/class/ptp/*/clock_name`.
pub fn find(class: &str, dev: &str) -> Option<Source> {
    let mut found: Vec<(usize, String, String)> = fs::read_dir(class)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = fs::read_to_string(entry.path().join("clock_name")).ok()?;
            let name = name.trim().to_string();
            let rank = NAMES.iter().position(|prefix| name.starts_with(prefix))?;
            Some((rank, entry.file_name().to_string_lossy().into_owned(), name))
        })
        .collect();
    found.sort();
    found.into_iter().find_map(|(_, device, name)| {
        let path = format!("{dev}/{device}");
        let file = fs::File::open(&path).ok()?;
        Some(Source {
            device: file,
            name,
            path,
        })
    })
}

fn now(clock: libc::clockid_t) -> io::Result<i128> {
    let mut time: libc::timespec = unsafe { std::mem::zeroed() };
    if unsafe { libc::clock_gettime(clock, &mut time) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(time.tv_sec as i128 * 1_000_000_000 + time.tv_nsec as i128)
}

/// The clocks a sync reads and sets; tests stand in for them.
trait Clocks {
    fn realtime(&self) -> io::Result<i128>;
    fn host(&self) -> io::Result<i128>;
    /// `CLOCK_MONOTONIC`, which a realtime step leaves alone.
    fn monotonic(&self) -> io::Result<i128>;
    fn set_realtime(&self, ns: i128) -> io::Result<()>;
    /// Called when the sync has to wait for another one to end.
    fn waiting(&self) {}
}

/// Steps realtime to the host's when it is STEP_NS or more off and returns
/// the step it made (ns; 0 for none). Holds `lock` from the first read to
/// the step; the step's target is the host's reading plus the monotonic
/// time since, not realtime plus the offset.
fn step(clocks: &impl Clocks, lock: &Mutex<()>) -> io::Result<i128> {
    let _one = match lock.try_lock() {
        Ok(guard) => guard,
        Err(TryLockError::Poisoned(poisoned)) => poisoned.into_inner(),
        Err(TryLockError::WouldBlock) => {
            clocks.waiting();
            lock.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
        }
    };
    let before = clocks.realtime()?;
    let host = clocks.host()?;
    let read = clocks.monotonic()?;
    let after = clocks.realtime()?;
    let offset = host - (before + after) / 2;
    if offset.abs() < STEP_NS {
        return Ok(0);
    }
    let from = clocks.realtime()?;
    let target = host + clocks.monotonic()? - read;
    clocks.set_realtime(target)?;
    Ok(target - from)
}

impl Source {
    /// The dynamic clock of the device (`FD_TO_CLOCKID`).
    fn clock(&self) -> libc::clockid_t {
        ((!self.device.as_raw_fd()) << 3) | 3
    }

    /// Steps realtime to the host's when it is past STEP_NS, one sync at a
    /// time in the agent; returns the step it made.
    pub fn sync(&self) -> io::Result<i128> {
        step(self, &SYNC)
    }
}

impl Clocks for Source {
    fn realtime(&self) -> io::Result<i128> {
        now(libc::CLOCK_REALTIME)
    }

    fn host(&self) -> io::Result<i128> {
        now(self.clock())
    }

    fn monotonic(&self) -> io::Result<i128> {
        now(libc::CLOCK_MONOTONIC)
    }

    fn set_realtime(&self, ns: i128) -> io::Result<()> {
        let time = libc::timespec {
            tv_sec: ns.div_euclid(1_000_000_000) as libc::time_t,
            tv_nsec: ns.rem_euclid(1_000_000_000) as libc::c_long,
        };
        if unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &time) } != 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(())
    }
}

/// Syncs realtime with the host's clock once, now, and returns the host's
/// time it read (ns since the epoch); None without a PTP clock. Called
/// before every `hello`, so a restored machine has the right time when it
/// starts a session instead of within the next INTERVAL.
pub fn sync_now() -> Option<i128> {
    let source = find("/sys/class/ptp", "/dev")?;
    match source.sync() {
        Ok(stepped) => {
            if stepped.abs() >= 1_000_000_000 {
                eprintln!(
                    "cube-agent: clock: stepped {:+.3} s to {} before hello",
                    stepped as f64 / 1e9,
                    source.name
                );
            }
            now(source.clock()).ok()
        }
        Err(error) => {
            eprintln!("cube-agent: clock: {}: {error}", source.path);
            None
        }
    }
}

/// Follows the host's clock for as long as the agent runs. Without a PTP
/// clock it says so once and looks again now and then (nothing to follow).
pub fn spawn() {
    let _ = std::thread::Builder::new().name("clock".into()).spawn(|| {
        let mut source = None;
        let mut said = false;
        loop {
            if source.is_none() {
                source = find("/sys/class/ptp", "/dev");
                match &source {
                    Some(found) => eprintln!(
                        "cube-agent: clock: following {} ({})",
                        found.name, found.path
                    ),
                    None if !said => {
                        eprintln!("cube-agent: clock: no PTP clock; realtime is not synced");
                        said = true;
                    }
                    None => {}
                }
            }
            if let Some(found) = &source {
                match found.sync() {
                    Ok(stepped) if stepped.abs() >= 1_000_000_000 => eprintln!(
                        "cube-agent: clock: stepped {:+.3} s to {}",
                        stepped as f64 / 1e9,
                        found.name
                    ),
                    Ok(_) => {}
                    Err(error) => {
                        eprintln!("cube-agent: clock: {}: {error}", found.path);
                        source = None;
                    }
                }
            }
            std::thread::sleep(if source.is_some() {
                INTERVAL
            } else {
                Duration::from_secs(10)
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_clock_is_picked_by_name() {
        let dir = tempfile::tempdir().unwrap();
        let (class, dev) = (dir.path().join("class"), dir.path().join("dev"));
        for (device, name) in [
            ("ptp0", "KVM virtual PTP\n"),
            ("ptp1", "Virtio PTP type 0/variant 0\n"),
            ("ptp2", "something else\n"),
        ] {
            fs::create_dir_all(class.join(device)).unwrap();
            fs::write(class.join(device).join("clock_name"), name).unwrap();
            fs::create_dir_all(&dev).unwrap();
            fs::write(dev.join(device), "").unwrap();
        }
        let found = find(class.to_str().unwrap(), dev.to_str().unwrap()).unwrap();
        assert_eq!(found.name, "Virtio PTP type 0/variant 0");
        assert!(found.path.ends_with("/ptp1"));
        fs::remove_file(dev.join("ptp1")).unwrap();
        let found = find(class.to_str().unwrap(), dev.to_str().unwrap()).unwrap();
        assert_eq!(
            found.name, "KVM virtual PTP",
            "the next one when it cannot be opened"
        );
        fs::remove_dir_all(class.join("ptp0")).unwrap();
        assert!(find(class.to_str().unwrap(), dev.to_str().unwrap()).is_none());
        assert!(find("/nonexistent", "/dev").is_none());
    }

    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc::{Sender, channel},
    };

    const HOST: i128 = 1_800_000_000_000_000_000;
    const BEHIND: i128 = 3_600_000_000;

    /// Where the other sync runs inside the first: at its host read (between
    /// its realtime reads), or at the first read after those three (for the
    /// step's target).
    #[derive(Clone, Copy)]
    enum At {
        Host,
        Step,
    }

    type Inside = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;

    /// A machine whose realtime is `realtime` and whose time stands still:
    /// the host clock reads HOST, the monotonic clock 0. `inside` runs once,
    /// at `at`.
    #[derive(Clone)]
    struct Fake {
        realtime: Arc<Mutex<i128>>,
        at: At,
        inside: Inside,
        realtime_reads: Arc<AtomicUsize>,
        events: Option<Sender<&'static str>>,
    }

    impl Fake {
        fn new(realtime: Arc<Mutex<i128>>, at: At) -> Self {
            Fake {
                realtime,
                at,
                inside: Arc::new(Mutex::new(None)),
                realtime_reads: Arc::new(AtomicUsize::new(0)),
                events: None,
            }
        }

        fn run_inside(&self) {
            if let Some(inside) = self.inside.lock().unwrap().take() {
                inside();
            }
        }
    }

    impl Clocks for Fake {
        fn realtime(&self) -> io::Result<i128> {
            if self.realtime_reads.fetch_add(1, Ordering::SeqCst) >= 2
                && let At::Step = self.at
            {
                self.run_inside();
            }
            Ok(*self.realtime.lock().unwrap())
        }
        fn host(&self) -> io::Result<i128> {
            if let At::Host = self.at {
                self.run_inside();
            }
            Ok(HOST)
        }
        fn monotonic(&self) -> io::Result<i128> {
            if self.realtime_reads.load(Ordering::SeqCst) >= 2
                && let At::Step = self.at
            {
                self.run_inside();
            }
            Ok(0)
        }
        fn set_realtime(&self, ns: i128) -> io::Result<()> {
            *self.realtime.lock().unwrap() = ns;
            Ok(())
        }
        fn waiting(&self) {
            if let Some(events) = &self.events {
                events.send("waiting").unwrap();
            }
        }
    }

    /// Realtime is BEHIND the host's. The hello's sync (A) is at `at` when
    /// the clock thread's sync (B) starts; A goes on once B has either
    /// stepped or is waiting for A. Returns realtime after both, and the
    /// steps A and B made.
    fn race(at: At, a_lock: &'static Mutex<()>, b_lock: &'static Mutex<()>) -> (i128, i128, i128) {
        let realtime = Arc::new(Mutex::new(HOST - BEHIND));
        let a = Fake::new(realtime.clone(), at);
        let (events, seen) = channel();
        let mut b = Fake::new(realtime.clone(), at);
        b.events = Some(events.clone());
        let (b_stepped, b_done) = channel();
        *a.inside.lock().unwrap() = Some(Box::new(move || {
            std::thread::spawn(move || {
                b_stepped.send(step(&b, b_lock).unwrap()).unwrap();
                let _ = events.send("stepped");
            });
            seen.recv().unwrap();
        }));
        let a_stepped = step(&a, a_lock).unwrap();
        a.run_inside(); // B still runs when A's sync never reached `at`
        let b_stepped = b_done.recv().unwrap();
        let after = *realtime.lock().unwrap();
        (after, a_stepped, b_stepped)
    }

    #[test]
    fn two_syncs_at_once_take_turns() {
        let (after, a, b) = race(At::Host, &SYNC, &SYNC);
        assert_eq!(after, HOST);
        assert_eq!(a, BEHIND, "the first sync steps by the whole offset");
        assert_eq!(b, 0, "the second waits for it and has nothing to step");
    }

    // Without the shared lock (each sync with a lock of its own, as before
    // SYNC) the step's target alone keeps realtime right.

    #[test]
    fn a_step_between_the_reads_is_not_added_again() {
        static OWN_A: Mutex<()> = Mutex::new(());
        static OWN_B: Mutex<()> = Mutex::new(());
        let (after, a, b) = race(At::Host, &OWN_A, &OWN_B);
        assert_eq!(b, BEHIND);
        assert_eq!(after, HOST, "not Mac run C7-3's HOST + BEHIND / 2");
        assert_eq!(a, 0, "the stale offset steps realtime to where it is");
    }

    #[test]
    fn a_step_between_the_reads_and_the_step_is_not_added_again() {
        static OWN_A: Mutex<()> = Mutex::new(());
        static OWN_B: Mutex<()> = Mutex::new(());
        let (after, a, b) = race(At::Step, &OWN_A, &OWN_B);
        assert_eq!(b, BEHIND);
        assert_eq!(after, HOST, "not HOST + BEHIND");
        assert_eq!(a, 0);
    }
}
