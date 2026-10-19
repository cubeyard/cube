//! `--only leave` (F-P7-2, #206's B-206-2): the runner leaves `cube.0`
//! while the agent's writer is blocked, and comes back.
//!
//! The mechanism, step by step (nothing here relies on chance):
//!
//!   1. A machine is set up as usual and a 512 KiB file of random bytes is
//!      written in its workspace; that channel is closed (the agent's writer
//!      is idle then) and the agent opens the port again.
//!   2. A raw connection (not `Channel`, whose reader drains every frame):
//!      the agent's `hello`, `machine_setup`, its answer and the `status`
//!      that says ready are read; after that **nothing more is read**.
//!   3. READS `read` requests for the whole file go out: about 700 KiB of
//!      answer each (base64 in the frame), ~22 MiB in all, far beyond what
//!      the host's socket buffers, QEMU's port and the guest's virtqueue can
//!      hold. The agent's writer blocks on the port; FILL_WAIT lets it get
//!      there.
//!   4. The runner leaves: the socket is closed. A virtio port takes no
//!      writes while the host's end is closed, so the writer stays blocked
//!      until the agent's 2 s cut-off.
//!   5. The driver waits until the agent says on the console that the runner
//!      closed its end, and at least AWAY after leaving, then connects again
//!      and waits PLAIN for a plain `hello` (no reset).
//!
//! Three checks, in this order, read from the console written since step 4:
//!   a. the agent kept its channel: no "the channel ended", no "Resource
//!      busy" and no "was busy". A keel up to v0.3.31 (before #206) fails
//!      here: its aborted writer still held the port when the agent opened
//!      it again (EBUSY), and its channel ended;
//!   b. a plain `hello` within PLAIN of the connect AWAY or more after
//!      leaving;
//!   c. the mechanism engaged: the agent said "writer cut off" (only an
//!      agent with #206 says it). Without it the run shows nothing about
//!      F-P7-2 and fails here rather than passing by luck.
use super::*;

const FILE_BYTES: usize = 512 * 1024;
const READS: u32 = 32;
const FILL_WAIT: Duration = Duration::from_secs(2);
const AWAY: Duration = Duration::from_millis(2500);
const PLAIN: Duration = Duration::from_secs(5);
/// What the agents print (packages/keel/agent/src/{channel,main}.rs).
const RUNNER_LEFT: &str = "the runner closed its end of cube.0";
const CUT_OFF: &str = "writer cut off";
const FORBIDDEN: [&str; 3] = ["the channel ended", "Resource busy", "was busy"];

/// The next frame of the raw connection, within `timeout`.
async fn next_frame(
    read: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
    timeout: Duration,
) -> Result<proto::DaemonFrame> {
    tokio::time::timeout(timeout, read_daemon_frame(read))
        .await
        .map_err(|_| anyhow!("no frame from the agent in {timeout:?}"))?
}

pub(super) async fn check(
    lab: &Lab,
    checks: &mut Checks,
    layers: &Path,
    image_layers: &[proto::Layer],
    documents: &[(&str, &[u8])],
) -> Result<Value> {
    // 1. A ready machine with the file.
    let dir = lab.new_disk("leave")?;
    let mut m = lab.start(&dir, layers)?;
    let ch = Channel::open(&m.ctl).await?;
    ch.info("hello", TIMEOUT).await?;
    ch.setup_after_hello(|| setup(image_layers, documents))
        .await?;
    let (header, _) = ch
        .run(
            "leave-file",
            &format!("head -c {FILE_BYTES} /dev/urandom > leave.bin && sync"),
            1,
        )
        .await?;
    ensure!(
        header["result"]["exitCode"] == 0,
        "the file was not written: {header}"
    );
    close(ch).await?;

    // 2. The raw connection, set up, then never read again.
    let stream = connect(&m.ctl, TIMEOUT).await?;
    let (read, mut write) = stream.into_split();
    let mut read = BufReader::new(read);
    // The runner's connect rule: the guest may see this connect right after
    // the close above as no change at all, so after PLAIN_HELLO without a
    // hello the reset on channel 0 asks for one.
    let mut reset = false;
    let session = loop {
        let wait = if reset { RESET_HELLO } else { PLAIN_HELLO };
        match next_frame(&mut read, wait).await {
            Ok(proto::DaemonFrame {
                t: Some(T::Hello(_)),
                session,
                ..
            }) => break session,
            Ok(_) => {}
            Err(_) if !reset => {
                write_frame(&mut write, &reset_frame()).await?;
                reset = true;
            }
            Err(error) => {
                return Err(error.context("no hello on the raw connection after the reset"));
            }
        }
    };
    write_frame(
        &mut write,
        &proto::DaemonFrame {
            ch: 1,
            t: Some(T::Req(proto::DaemonRequest {
                op: Some(setup(image_layers, documents)),
            })),
            session: session.clone(),
        },
    )
    .await?;
    let (mut answered, mut ready) = (false, false);
    while !(answered && ready) {
        let frame = next_frame(&mut read, TIMEOUT).await?;
        match frame.t {
            Some(T::Ans(answer)) if frame.ch == 1 => {
                ensure!(
                    matches!(answer.result, Some(Answer::Done(_))),
                    "machine_setup on the raw connection: {answer:?}"
                );
                answered = true;
            }
            Some(T::Status(info)) => ready = info.ready,
            _ => {}
        }
    }

    // 3. Answers the runner will never read.
    let request = format!("{}\n", json!({"path": "leave.bin"})).into_bytes();
    for n in 0..READS {
        write_frame(
            &mut write,
            &proto::DaemonFrame {
                ch: 2 + n,
                t: Some(T::Req(proto::DaemonRequest {
                    op: Some(Op::Guest(proto::GuestRequest {
                        op: "read".into(),
                        data: request.clone(),
                    })),
                })),
                session: session.clone(),
            },
        )
        .await?;
    }
    tokio::time::sleep(FILL_WAIT).await;

    // 4. The runner leaves.
    let console_from = fs::metadata(&m.console).map_or(0, |meta| meta.len()) as usize;
    let left_before = count_in(&m.console, RUNNER_LEFT);
    drop(write);
    drop(read);
    let left = Instant::now();
    log(&format!(
        "leave: {READS} reads of {FILE_BYTES} bytes unread; the runner left cube.0"
    ));

    // 5. Back, after the agent saw it and at least AWAY.
    await_console(&m.console, RUNNER_LEFT, left_before).await?;
    let saw_ms = left.elapsed().as_millis();
    tokio::time::sleep(AWAY.saturating_sub(left.elapsed())).await;
    let away = left.elapsed();
    let ch = Channel::open(&m.ctl).await?;
    let connected = Instant::now();
    let hello = ch.info("hello", PLAIN).await;
    let hello_ms = connected.elapsed().as_millis();
    // N-206-1: a half frame of the old connection reaching the new one shows
    // as a frame of another session dropped (or a reader error in the log).
    let foreign = ch.foreign.load(Ordering::SeqCst);
    // What the agent says after a reconnect is on the console before its
    // hello; a little more for the serial port.
    tokio::time::sleep(Duration::from_millis(500)).await;
    let console = fs::read(&m.console).unwrap_or_default();
    let since = String::from_utf8_lossy(&console[console_from.min(console.len())..]).into_owned();
    let (found, cut_off) = verdict(&since);
    log(&format!(
        "leave: the console since the runner left:\n{since}"
    ));

    checks.ok(
        found.is_empty(),
        "the agent kept its channel after the runner left while its writer was blocked (F-P7-2): no \"the channel ended\", \"Resource busy\" or \"was busy\" on the console",
        format!("found: {found:?}"),
    )?;
    checks.ok(
        hello.is_ok(),
        "a plain hello within 5 s of the runner connecting again, 2.5 s or more after it left",
        format!(
            "away {} ms, {}",
            away.as_millis(),
            match &hello {
                Ok(_) => format!("hello in {hello_ms} ms"),
                Err(error) => format!("{error:#}; frames of another session dropped: {foreign}"),
            }
        ),
    )?;
    checks.ok(
        cut_off,
        "the writer was blocked when the runner left: the agent cut it off (\"writer cut off\" on the console)",
        "without it this run shows nothing about F-P7-2",
    )?;
    // The machine still works on the new connection.
    ch.setup_after_hello(|| setup(image_layers, documents))
        .await?;
    let (header, output) = ch.run("leave-after", "echo still here", 2).await?;
    ensure!(
        header["result"]["exitCode"] == 0 && output.trim() == "still here",
        "after the reconnect: {header} {output:?}"
    );
    drop(ch);
    quit(&mut m).await?;
    Ok(json!({
        "reads": READS,
        "fileBytes": FILE_BYTES,
        "agentSawLeaveMs": saw_ms,
        "awayMs": away.as_millis(),
        "helloMs": hello_ms,
        "writerCutOff": cut_off,
        "foreignFramesBeforeHello": foreign,
    }))
}

/// From the console since the runner left: the lines that say the channel
/// ended or the port was busy, and whether the writer was cut off.
fn verdict(since: &str) -> (Vec<&str>, bool) {
    let found = since
        .lines()
        .filter(|line| FORBIDDEN.iter().any(|f| line.contains(f)))
        .collect();
    (found, since.lines().any(|line| line.contains(CUT_OFF)))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The console of keel v0.3.31's agent in this check under TCG
    /// (arm64, QEMU 11.1.2), as it came, and what #206's agent says.
    #[test]
    fn the_old_agents_console_fails_and_the_new_ones_passes() {
        let old = "cube-agent: the runner closed its end of cube.0; closing the port\n\
cube-agent: the channel ended: Err(Os { code: 16, kind: ResourceBusy, message: \"Resource busy\" })\n\
cube-init: /sbin/cube-agent ended (exit status 1) after 6092 ms; starting it again in 100 ms\n\
cube-agent: clock: following Virtio PTP type 0/variant 0 (/dev/ptp0)\n";
        let (found, cut_off) = verdict(old);
        assert_eq!(found.len(), 1, "{found:?}");
        assert!(found[0].contains("the channel ended") && !cut_off);
        let new = "cube-agent: the writer did not finish its frame in 2 s; writer cut off\n\
cube-agent: the runner closed its end of cube.0; closing the port\n";
        assert_eq!(verdict(new), (vec![], true));
        let busy = "cube-agent: the writer did not finish its frame in 2 s; writer cut off\n\
cube-agent: cube.0 was busy 1 time(s) before it opened\n";
        assert_eq!(
            verdict(busy).0.len(),
            1,
            "a busy port is a finding (N-206-3)"
        );
    }
}
