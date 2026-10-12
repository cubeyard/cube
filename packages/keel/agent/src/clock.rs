//! The machine's `CLOCK_REALTIME`, kept in step with the host's all the
//! time (keel plan, "Guest bring-up"), so a resume needs no message for
//! time: the guest's clocks stop while it is paused or saved, and the next
//! sync puts realtime right. The host's clock is a PTP clock picked by its
//! name, not its number: virtio-rtc's "Virtio PTP" (keel's QEMU arguments
//! carry `virtio-rtc-pci`; type 0 is UTC), else KVM's "KVM virtual PTP".
//! Both read the host's realtime clock.
//!
//! Two callers sync: the clock thread every INTERVAL and `sync_now` before
//! every hello. A sync is a read of realtime, the host and realtime again,
//! then a step by the difference; another step between those reads would
//! be added twice (a restore's +3.6 s step, then a second +1.8 s from the
//! stale reads). So a sync holds SYNC from its first read to its step. The
//! agent is the only thing in the machine that sets realtime.
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
    fn set_realtime(&self, ns: i128) -> io::Result<()>;
    /// Called when the sync has to wait for another one to end.
    fn waiting(&self) {}
}

/// Steps realtime to the host's when it is STEP_NS or more off and returns
/// the offset (host minus realtime, ns). Holds `lock` from the first read to
/// the step.
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
    let after = clocks.realtime()?;
    let offset = host - (before + after) / 2;
    if offset.abs() >= STEP_NS {
        clocks.set_realtime(clocks.realtime()? + offset)?;
    }
    Ok(offset)
}

impl Source {
    /// The dynamic clock of the device (`FD_TO_CLOCKID`).
    fn clock(&self) -> libc::clockid_t {
        ((!self.device.as_raw_fd()) << 3) | 3
    }

    /// Steps realtime to the host's when it is past STEP_NS, one sync at a
    /// time in the agent; returns the offset it found.
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
        Ok(offset) => {
            if offset.abs() >= 1_000_000_000 {
                eprintln!(
                    "cube-agent: clock: stepped {:+.3} s to {} before hello",
                    offset as f64 / 1e9,
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
                    Ok(offset) if offset.abs() >= 1_000_000_000 => eprintln!(
                        "cube-agent: clock: stepped {:+.3} s to {}",
                        offset as f64 / 1e9,
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
        mpsc::{Sender, channel},
    };

    const HOST: i128 = 1_800_000_000_000_000_000;
    const BEHIND: i128 = 3_600_000_000;

    type Inside = Arc<Mutex<Option<Box<dyn FnOnce() + Send>>>>;

    /// A machine whose realtime is `realtime` and whose host clock stands
    /// still at HOST. `inside` runs once, at this caller's host read.
    #[derive(Clone)]
    struct Fake {
        realtime: Arc<Mutex<i128>>,
        inside: Inside,
        events: Option<Sender<&'static str>>,
    }

    impl Fake {
        fn new(realtime: Arc<Mutex<i128>>) -> Self {
            Fake {
                realtime,
                inside: Arc::new(Mutex::new(None)),
                events: None,
            }
        }
    }

    impl Clocks for Fake {
        fn realtime(&self) -> io::Result<i128> {
            Ok(*self.realtime.lock().unwrap())
        }
        fn host(&self) -> io::Result<i128> {
            if let Some(inside) = self.inside.lock().unwrap().take() {
                inside();
            }
            Ok(HOST)
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

    /// The hello's sync (A) is between its realtime reads when the clock
    /// thread's sync (B) starts; A goes on once B has either stepped or is
    /// waiting for A. Returns realtime after both, and both offsets.
    fn race(a_lock: &'static Mutex<()>, b_lock: &'static Mutex<()>) -> (i128, i128, i128) {
        let realtime = Arc::new(Mutex::new(HOST - BEHIND));
        let a = Fake::new(realtime.clone());
        let (events, seen) = channel();
        let mut b = Fake::new(realtime.clone());
        b.events = Some(events.clone());
        let (b_offset, b_done) = channel();
        *a.inside.lock().unwrap() = Some(Box::new(move || {
            std::thread::spawn(move || {
                b_offset.send(step(&b, b_lock).unwrap()).unwrap();
                let _ = events.send("stepped");
            });
            seen.recv().unwrap();
        }));
        let a_offset = step(&a, a_lock).unwrap();
        let b_offset = b_done.recv().unwrap();
        let after = *realtime.lock().unwrap();
        (after, a_offset, b_offset)
    }

    #[test]
    fn two_syncs_at_once_step_the_clock_once() {
        let (after, a, b) = race(&SYNC, &SYNC);
        assert_eq!(after, HOST, "realtime is the host's, not stepped twice");
        assert_eq!(a, BEHIND, "the first sync steps by the whole offset");
        assert_eq!(b, 0, "the second finds nothing left to step");
    }

    #[test]
    fn without_one_lock_the_second_step_adds_half_the_first_again() {
        // The control: each sync with a lock of its own is what the agent did
        // before SYNC, and gives Mac run C7-3's +3.6 s then +1.8 s.
        static OWN_A: Mutex<()> = Mutex::new(());
        static OWN_B: Mutex<()> = Mutex::new(());
        let (after, a, b) = race(&OWN_A, &OWN_B);
        assert_eq!(b, BEHIND);
        assert_eq!(a, BEHIND / 2);
        assert_eq!(after, HOST + BEHIND / 2);
    }
}
