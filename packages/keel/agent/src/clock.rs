//! The machine's `CLOCK_REALTIME`, kept in step with the host's all the
//! time (keel plan, "Guest bring-up"), so a resume needs no message for
//! time: the guest's clocks stop while it is paused or saved, and the next
//! sync puts realtime right. The host's clock is a PTP clock picked by its
//! name, not its number: virtio-rtc's "Virtio PTP" (keel's QEMU arguments
//! carry `virtio-rtc-pci`; type 0 is UTC), else KVM's "KVM virtual PTP".
//! Both read the host's realtime clock.
use std::{fs, io, os::fd::AsRawFd, time::Duration};

/// How often the clock is compared. Realtime is right within this (plus a
/// read) after a resume.
pub const INTERVAL: Duration = Duration::from_millis(500);
/// A smaller offset is left alone (reading the PTP clock costs a few µs
/// under KVM, a few ms under TCG).
const STEP_NS: i128 = 20_000_000;
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

impl Source {
    /// The dynamic clock of the device (`FD_TO_CLOCKID`).
    fn clock(&self) -> libc::clockid_t {
        ((!self.device.as_raw_fd()) << 3) | 3
    }

    /// The host's time minus this machine's realtime, in ns: the PTP clock
    /// read between two realtime reads.
    pub fn offset(&self) -> io::Result<i128> {
        let before = now(libc::CLOCK_REALTIME)?;
        let host = now(self.clock())?;
        let after = now(libc::CLOCK_REALTIME)?;
        Ok(host - (before + after) / 2)
    }

    /// Steps realtime by the offset when it is past STEP_NS; returns it.
    pub fn sync(&self) -> io::Result<i128> {
        let offset = self.offset()?;
        if offset.abs() >= STEP_NS {
            let target = now(libc::CLOCK_REALTIME)? + offset;
            let time = libc::timespec {
                tv_sec: target.div_euclid(1_000_000_000) as libc::time_t,
                tv_nsec: target.rem_euclid(1_000_000_000) as libc::c_long,
            };
            if unsafe { libc::clock_settime(libc::CLOCK_REALTIME, &time) } != 0 {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(offset)
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
}
