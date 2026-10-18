//! `--only memory` (masterplan S-7b, phase 7): whether a keel machine gives
//! memory back to its host, and how much smaller that makes a snapshot.
//!
//! The guest frees memory in two ways a thread does: a file it wrote is
//! deleted (its page cache is freed), and `snapshot_prepare` drops the page
//! cache and compacts memory. With `virtio-balloon-pci,free-page-reporting=on`
//! the guest kernel reports freed 2 MiB blocks to QEMU (about 2 s after they
//! are freed), and QEMU discards them, so its resident memory falls. Two
//! machines on fresh disks, `FILL` = half the guest memory:
//!
//!   A  setup; FILL MiB written to a file that stays; saved without a
//!      prepare. Its memory file (allocated bytes) is the baseline.
//!   B  setup; a FILL MiB file written and deleted: QEMU's resident memory
//!      must rise by at least FILL/2 and then give at least half of that
//!      rise back within SETTLE. Again written, kept, then
//!      `snapshot_prepare`: half the new rise back within SETTLE, then
//!      saved; the memory file must be at least FILL/2 smaller than A's.
//!
//! `--control reporting` runs the same with `free-page-reporting=off`: the
//! first give-back check must fail. QEMU's resident memory is read from
//! `/proc/PID/status` on Linux and with `/bin/ps` on macOS (macOS also
//! compresses memory, which lowers RSS without reporting; the control tells
//! the two apart). Every sample goes to results.json; the thresholds are
//! the check's, not product limits.
use super::*;

/// How long freed memory may take to come back to the host: the guest
/// reports after about 2 s; the rest is margin for slow hosts.
const SETTLE: Duration = Duration::from_secs(15);
const SAMPLE: Duration = Duration::from_millis(250);

/// `VmRSS:` in `/proc/PID/status`, in bytes.
pub(super) fn parse_proc_rss(status: &str) -> Result<u64> {
    let line = status
        .lines()
        .find(|l| l.starts_with("VmRSS:"))
        .ok_or_else(|| anyhow!("no VmRSS line"))?;
    let mut fields = line.split_whitespace().skip(1);
    let value: u64 = fields
        .next()
        .ok_or_else(|| anyhow!("VmRSS without a value: {line:?}"))?
        .parse()
        .with_context(|| format!("VmRSS: {line:?}"))?;
    ensure!(fields.next() == Some("kB"), "VmRSS not in kB: {line:?}");
    Ok(value * 1024)
}

/// `ps -o rss= -p PID`: KiB, one number.
pub(super) fn parse_ps_rss(output: &str) -> Result<u64> {
    let value: u64 = output
        .trim()
        .parse()
        .with_context(|| format!("ps rss: {output:?}"))?;
    Ok(value * 1024)
}

fn resident(pid: u32) -> Result<u64> {
    if cfg!(target_os = "linux") {
        parse_proc_rss(&fs::read_to_string(format!("/proc/{pid}/status"))?)
    } else {
        let out = std::process::Command::new("/bin/ps")
            .args(["-o", "rss=", "-p", &pid.to_string()])
            .output()?;
        ensure!(out.status.success(), "/bin/ps -p {pid}: {}", out.status);
        parse_ps_rss(&String::from_utf8_lossy(&out.stdout))
    }
}

const MIB: f64 = 1024.0 * 1024.0;

/// Resident memory over time after an event: (ms after it, bytes).
#[derive(Default)]
pub(super) struct Samples(pub Vec<(u128, u64)>);

impl Samples {
    /// When the memory first fell to `target` or below.
    pub fn reached(&self, target: u64) -> Option<u128> {
        self.0.iter().find(|(_, b)| *b <= target).map(|(ms, _)| *ms)
    }

    fn json(&self) -> Value {
        json!(
            self.0
                .iter()
                .map(|(ms, b)| json!([ms, (*b as f64 / MIB * 10.0).round() / 10.0]))
                .collect::<Vec<_>>()
        )
    }
}

/// The give-back rule: of a rise from `before` to `peak`, at least half
/// back. The target resident size.
pub(super) fn half_back(before: u64, peak: u64) -> u64 {
    peak - peak.saturating_sub(before) / 2
}

/// Samples until the memory is at `target` or SETTLE has passed.
async fn watch_fall(pid: u32, target: u64) -> Result<Samples> {
    let t = Instant::now();
    let mut samples = Samples::default();
    loop {
        let bytes = resident(pid)?;
        samples.0.push((t.elapsed().as_millis(), bytes));
        if bytes <= target || t.elapsed() >= SETTLE {
            return Ok(samples);
        }
        tokio::time::sleep(SAMPLE).await;
    }
}

/// A settled reading: the median of five samples a second apart, after the
/// boot's own freed memory had time to be reported.
async fn settled(pid: u32) -> Result<u64> {
    let mut values = vec![];
    for _ in 0..5 {
        tokio::time::sleep(Duration::from_secs(1)).await;
        values.push(resident(pid)?);
    }
    values.sort();
    Ok(values[2])
}

fn allocated(path: &Path) -> Result<u64> {
    use std::os::unix::fs::MetadataExt;
    Ok(fs::metadata(path)?.blocks() * 512)
}

fn mib(bytes: u64) -> f64 {
    (bytes as f64 / MIB * 10.0).round() / 10.0
}

fn fill(name: &str, mib: u32) -> String {
    format!(
        "dd if=/dev/zero of={name} bs=1M count={mib} conv=fsync status=none && ls -s --block-size=1M {name}"
    )
}

async fn ready_machine(
    lab: &Lab,
    name: &str,
    layers: &Path,
    image_layers: &[proto::Layer],
    documents: &[(&str, &[u8])],
) -> Result<(PathBuf, Machine, Arc<Channel>, u32)> {
    let dir = lab.new_disk(name)?;
    let m = lab.start(&dir, layers)?;
    let pid = m
        .child
        .id()
        .ok_or_else(|| anyhow!("{name}: QEMU has no pid"))?;
    let ch = Channel::open(&m.ctl).await?;
    ch.info("hello", TIMEOUT).await?;
    ch.setup_after_hello(|| setup(image_layers, documents))
        .await?;
    Ok((dir, m, ch, pid))
}

pub(super) async fn check(
    lab: &Lab,
    checks: &mut Checks,
    layers: &Path,
    image_layers: &[proto::Layer],
    documents: &[(&str, &[u8])],
) -> Result<Value> {
    let memory_mib: u32 = lab.o.memory.parse().context("--memory")?;
    let fill_mib = memory_mib / 2;
    let fill_bytes = u64::from(fill_mib) * 1024 * 1024;

    // A: the page cache kept, saved without a prepare.
    let (dir, mut m, ch, pid) =
        ready_machine(lab, "memory-a", layers, image_layers, documents).await?;
    let (_, out) = ch.run("mem-a-fill", &fill("keep", fill_mib), 1).await?;
    let a_resident = settled(pid).await?;
    let a_file = dir.join("memory");
    let a_save = save(&mut m, &a_file).await?;
    let a_bytes = allocated(&a_file)?;
    drop(ch);
    log(&format!(
        "memory A: wrote {}, resident {} MiB, saved without a prepare in {} ms: {} MiB allocated",
        out.trim(),
        mib(a_resident),
        a_save.as_millis(),
        mib(a_bytes)
    ));

    // B: a file deleted, then the page cache dropped by the prepare.
    let (dir, mut m, ch, pid) =
        ready_machine(lab, "memory-b", layers, image_layers, documents).await?;
    let base = settled(pid).await?;
    let (_, out) = ch.run("mem-b-fill", &fill("gone", fill_mib), 1).await?;
    let peak = settled(pid).await?;
    checks.ok(
        peak >= base + fill_bytes / 2,
        "the guest's page cache shows in QEMU's resident memory (a rise of at least half the file)",
        format!(
            "{} MiB before, {} MiB after writing {}",
            mib(base),
            mib(peak),
            out.trim()
        ),
    )?;
    let _ = ch.run("mem-b-rm", "rm gone", 1).await?;
    let target = half_back(base, peak);
    let deleted = watch_fall(pid, target).await?;
    let deleted_ms = deleted.reached(target);
    checks.ok(
        deleted_ms.is_some(),
        "a deleted file's page cache goes back to the host: QEMU's resident memory gives at least half the rise back within 15 s (free page reporting)",
        format!(
            "{} MiB before, {} MiB peak, target {} MiB, lowest {} MiB in {} ms",
            mib(base),
            mib(peak),
            mib(target),
            mib(deleted.0.iter().map(|s| s.1).min().unwrap_or(peak)),
            deleted.0.last().map_or(0, |s| s.0)
        ),
    )?;
    let low = settled(pid).await?;
    let (_, out) = ch.run("mem-b-keep", &fill("keep", fill_mib), 1).await?;
    let kept = settled(pid).await?;
    let t = Instant::now();
    let (answer, status) = ch.prepare().await?;
    let prepare_ms = t.elapsed().as_millis();
    checks.ok(
        prepared(&answer, &status),
        "snapshot_prepare is answered done and the status says prepared for a snapshot",
        format!("{answer:?} {status:?}"),
    )?;
    let target = half_back(low, kept);
    let dropped = watch_fall(pid, target).await?;
    let dropped_ms = dropped.reached(target);
    checks.ok(
        kept >= low + fill_bytes / 2 && dropped_ms.is_some(),
        "the page cache snapshot_prepare drops goes back to the host: at least half the rise back within 15 s of its answer",
        format!(
            "{} MiB before writing {}, {} MiB after, target {} MiB, lowest {} MiB in {} ms",
            mib(low),
            out.trim(),
            mib(kept),
            mib(target),
            mib(dropped.0.iter().map(|s| s.1).min().unwrap_or(kept)),
            dropped.0.last().map_or(0, |s| s.0)
        ),
    )?;
    let b_resident = resident(pid)?;
    let b_file = dir.join("memory");
    let b_save = save(&mut m, &b_file).await?;
    let b_bytes = allocated(&b_file)?;
    drop(ch);
    checks.ok(
        b_bytes + fill_bytes / 2 <= a_bytes,
        "a save after snapshot_prepare and reporting is at least half the file smaller than one without (allocated bytes of the memory file)",
        format!("{} MiB without the prepare, {} MiB with it", mib(a_bytes), mib(b_bytes)),
    )?;
    Ok(json!({
        "guestMemoryMiB": memory_mib,
        "fillMiB": fill_mib,
        "freePageReporting": lab.o.control != Some(Control::Reporting),
        "a": {
            "residentMiB": mib(a_resident),
            "saveMs": a_save.as_millis(),
            "memoryFile": {"allocatedMiB": mib(a_bytes), "apparentMiB": mib(fs::metadata(&a_file)?.len())},
        },
        "b": {
            "baseMiB": mib(base),
            "peakMiB": mib(peak),
            "deleted": {"reachedMs": deleted_ms, "samples": deleted.json()},
            "beforeKeepMiB": mib(low),
            "keptMiB": mib(kept),
            "prepareMs": prepare_ms,
            "prepared": {"reachedMs": dropped_ms, "samples": dropped.json()},
            "residentAtSaveMiB": mib(b_resident),
            "saveMs": b_save.as_millis(),
            "memoryFile": {"allocatedMiB": mib(b_bytes), "apparentMiB": mib(fs::metadata(&b_file)?.len())},
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proc_status_rss_is_read_in_bytes() {
        let status =
            "Name:\tqemu-system-x86\nVmPeak:\t 9000 kB\nVmRSS:\t  524288 kB\nRssAnon:\t 1 kB\n";
        assert_eq!(parse_proc_rss(status).unwrap(), 512 * 1024 * 1024);
        assert!(parse_proc_rss("Name:\tx\n").is_err());
        assert!(parse_proc_rss("VmRSS:\t12 MB\n").is_err());
    }

    #[test]
    fn ps_rss_is_kib() {
        assert_eq!(parse_ps_rss("  2048\n").unwrap(), 2 * 1024 * 1024);
        assert!(parse_ps_rss("").is_err());
    }

    #[test]
    fn half_of_the_rise_back() {
        assert_eq!(half_back(100, 300), 200);
        // No rise: the target is where it is, so the rule cannot pass on
        // nothing (the rise check before it fails first).
        assert_eq!(half_back(300, 300), 300);
        assert_eq!(half_back(400, 300), 300);
        let s = Samples(vec![(0, 300), (250, 260), (500, 199), (750, 150)]);
        assert_eq!(s.reached(200), Some(500));
        assert_eq!(s.reached(100), None);
    }
}
