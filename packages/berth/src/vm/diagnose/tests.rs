use super::*;

#[test]
fn terminal_controls_are_escaped() {
    let hostile = b"ok\x1b[2J\x1b]0;title\x07\x1bc\r\nline\rover\x00\x7f\xc2\x9b31m\xe2\x80\xae\xef\xbb\xbfend\xff\xfe\ttab\\x41";
    let (text, cut) = safe_text(hostile, 4096);
    assert!(!cut);
    assert_eq!(
        text,
        "ok\\x1b[2J\\x1b]0;title\\x07\\x1bc\nline\\x0dover\\x00\\x7f\\u{009b}31m\\u{202e}\\u{feff}end\\xff\\xfe\ttab\\x41"
    );
    assert!(
        !text
            .chars()
            .any(|c| c != '\n' && c != '\t' && unsafe_char(c))
    );
    assert_eq!(safe_text(text.as_bytes(), 4096).0, text, "idempotent");
    let (short, cut) = safe_text(b"\x1b\x1b\x1b", 9);
    assert!(cut);
    assert_eq!(short, "\\x1b\\x1b", "never half an escape");
}

#[test]
fn secrets_are_redacted() {
    let text = "a ghp_0123456789abcdefABCDEF b\nAuthorization: Bearer eyJhbGciOi.payload.sig\n\
        password=hunter2 token: \"abc def\" {\"frameToken\":\"0123abcd\"} tokens: 5\n\
        -----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk\n-----END OPENSSH PRIVATE KEY-----\nafter\n\
        sk-ant-api03-AAAAAAAAAAAAAAAA ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA host";
    let redacted = redact(text);
    for secret in [
        "0123456789abcdefABCDEF",
        "eyJhbGciOi",
        "hunter2",
        "\"abc",
        "0123abcd",
        "b3BlbnNzaC1rZXk",
        "api03-AAAA",
    ] {
        assert!(!redacted.contains(secret), "{secret} in {redacted}");
    }
    for kept in [
        "tokens: 5",
        "after",
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAA host",
        "[redacted private key]",
    ] {
        assert!(redacted.contains(kept), "{kept} missing in {redacted}");
    }
    assert_eq!(redact(&redacted), redacted, "idempotent");
    // An excerpt cut inside a key.
    assert_eq!(
        redact("x\n-----BEGIN RSA PRIVATE KEY-----\nMIIE"),
        "x\n[redacted private key]"
    );
    assert_eq!(
        redact("MIIEpAIB\n-----END RSA PRIVATE KEY-----\ny"),
        "[redacted private key]\ny"
    );
    assert_eq!(
        redact("-----BEGIN CERTIFICATE-----\nMIIB\n"),
        "-----BEGIN CERTIFICATE-----\nMIIB\n",
        "certificates are public"
    );
}

/// Synthetic key body lines: what a key line looks like, no real key.
fn body(lines: usize) -> Vec<String> {
    (0..lines)
        .map(|n| format!("SyntheticKeyBody{n}Line{}", "Ab9+/Cd8".repeat(7))[..70].to_string())
        .collect()
}

fn assert_no_body(text: &str, lines: &[String]) {
    for line in lines {
        for piece in [&line[..16], &line[line.len() - 16..]] {
            assert!(!text.contains(piece), "{piece} leaked in {text}");
        }
    }
}

#[test]
fn keys_cut_or_escaped_are_redacted() {
    let lines = body(6);
    let joined = lines.join("\n");
    let key =
        format!("-----BEGIN OPENSSH PRIVATE KEY-----\n{joined}\n-----END OPENSSH PRIVATE KEY-----");
    // An excerpt whose tail starts inside a key, after a head that has
    // other BEGIN and END lines (a certificate, cloud-init's public keys).
    let head = "boot\n-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n\
        -----BEGIN SSH HOST KEY KEYS-----\nssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPublicHostKeyStaysVisible0123456789abcdefABCD root@cube\n\
        -----END SSH HOST KEY KEYS-----\n";
    let cut = &key[60..];
    let text = format!("{head}\n[... 900 bytes omitted ...]\n{cut}\nlogin:");
    let redacted = redact(&text);
    assert_no_body(&redacted, &lines);
    for kept in [
        "boot",
        "MIIB",
        "PublicHostKeyStaysVisible",
        "omitted ...]",
        "login:",
    ] {
        assert!(redacted.contains(kept), "{kept} missing in {redacted}");
    }
    // A tail that starts inside a key after a whole key.
    let text = format!("{key}\nmiddle\n[... 9 bytes omitted ...]\n{cut}\nend");
    let redacted = redact(&text);
    assert_no_body(&redacted, &lines);
    assert!(redacted.contains("middle") && redacted.contains("end"));
    // Both BEGIN and END cut off: body lines alone, the short last one too.
    let short = "ShortLastLine0Ab9==";
    let text = format!(
        "x\n{}\n{short}\ncloud-init[1]: done",
        lines[1..5].join("\n")
    );
    let redacted = redact(&text);
    assert_no_body(&redacted, &lines[1..5]);
    assert!(!redacted.contains(short), "{redacted}");
    assert!(redacted.contains("cloud-init[1]: done"));
    // A console that ends lines with a lone CR, escaped by safe_text.
    let cr = key.replace('\n', "\r");
    let (escaped, _) = safe_text(cr.as_bytes(), 1 << 16);
    assert_no_body(&redact(&escaped), &lines);
    // The key as a JSON or Python string: one line, escaped newlines.
    let one_line = format!(
        "ssh_keys: {{'ed25519_private': '{}\\n'}} next",
        key.replace('\n', "\\n")
    );
    let redacted = redact(&one_line);
    assert_no_body(&redacted, &lines);
    assert!(redacted.ends_with(" next"), "{redacted}");
    // Its END escaped too, cut off where the excerpt starts.
    assert_no_body(&redact(&one_line[90..]), &lines);
    // Other armors and cases; a prefix on every line.
    for (begin, end) in [
        (
            "-----BEGIN PGP PRIVATE KEY BLOCK-----",
            "-----END PGP PRIVATE KEY BLOCK-----",
        ),
        ("-----begin private key-----", "-----end private key-----"),
        (
            "-----BEGIN ENCRYPTED PRIVATE KEY-----",
            "-----END ENCRYPTED PRIVATE KEY-----",
        ),
    ] {
        let prefixed = format!(
            "[ 12.5] ci: {begin}\n[ 12.5] ci: {}\n[ 12.5] ci: {end}\nok",
            lines.join("\n[ 12.5] ci: ")
        );
        let redacted = redact(&prefixed);
        assert_no_body(&redacted, &lines);
        assert!(redacted.ends_with("\nok"), "{redacted}");
    }
    // Cut by clean's bound inside the key.
    let (cleaned, cut) = clean(key.as_bytes(), 200);
    assert!(cut);
    assert_no_body(&cleaned, &lines);
    // Fingerprints, hashes and paths stay.
    for kept in [
        "256 SHA256:Ab9Cd8Ef7Gh6Ij5Kl4Mn3Op2Qr1St0UvWxYz0123456 root@cube (ED25519)",
        "sha256 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
        "/opt/homebrew/share/qemu/edk2-aarch64-code.fd",
    ] {
        assert_eq!(redact(kept), kept);
    }
    for text in [&text, &one_line, &escaped] {
        let once = redact(text);
        assert_eq!(redact(&once), once, "idempotent");
    }
}

#[test]
fn key_redaction_is_bounded() {
    let lines = body(6);
    // A key whose END fell into the omitted middle: the tail stays.
    let text = format!(
        "boot\n-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n[... 5000 bytes omitted ...]\n{}\nreached login\n",
        lines[..2].join("\n"),
        lines[4..].join("\n")
    );
    let redacted = redact(&text);
    assert_no_body(&redacted, &lines);
    assert!(
        redacted.contains("omitted ...]") && redacted.contains("reached login"),
        "{redacted}"
    );
    // Prefixed lines with changing timestamps, cut at both ends; the
    // short last line goes too, and so does one after an escaped CR.
    let stamped: Vec<String> = (0..4)
        .map(|n| format!("[   12.5{n}] cloud-init[600]: {}", lines[n]))
        .collect();
    let text = format!(
        "{}\n[   12.59] cloud-init[600]: ShortTail0Ab9==\n[   12.60] ok: done",
        stamped.join("\n")
    );
    let redacted = redact(&text);
    assert_no_body(&redacted, &lines[..4]);
    assert!(!redacted.contains("ShortTail0Ab9"), "{redacted}");
    assert!(redacted.ends_with("ok: done"), "{redacted}");
    let (cr, _) = safe_text(
        format!("{}\r{}\rShortTail0Ab9==\rafter it", lines[0], lines[1]).as_bytes(),
        4096,
    );
    assert!(!redact(&cr).contains("ShortTail0Ab9"), "{cr}");
    let (prefixed_cut, _) = clean(text.as_bytes(), 120);
    assert_no_body(&prefixed_cut, &lines[..1]);
    // The first line of the text, a long journal prefix, a trailing space.
    let journal = "Oct 07 19:12:40 ip-10-0-0-123.eu-west-1.compute.internal cloud-init[600]: ";
    for text in [
        format!(
            "[   12.50] cloud-init[600]: {}\n[   12.51] cloud-init[600]: ShortTail0Ab9==",
            lines[0]
        ),
        format!("x\n{journal}{}\n{journal}ShortTail0Ab9==\nok", lines[0]),
        format!("{}\nShortTail0Ab9== \nok", lines[0]),
    ] {
        assert!(!redact(&text).contains("ShortTail0Ab9"), "{text}");
    }
    // A key's lines end with its short last one: later lines stay.
    let redacted = redact(&format!(
        "{}\n{}\nlast0Ab9\ndone\nStarting",
        lines[0], lines[1]
    ));
    assert!(redacted.ends_with("\ndone\nStarting"), "{redacted}");
    // Linear time on a large, hostile console.
    let hostile = format!(
        "{}{}{}",
        "[    1.234567] usb 1-1: new device found, idVendor=1d6b\n".repeat(4000),
        "a".repeat(64 * 1024),
        " -PRIVATE KEY".repeat(10_000)
    );
    let started = std::time::Instant::now();
    let _ = redact(&hostile);
    let _ = redact(&"ab cd ".repeat(40_000));
    let _ = redact(&"-".repeat(256 * 1024));
    assert!(
        started.elapsed() < std::time::Duration::from_secs(2),
        "{:?}",
        started.elapsed()
    );
}

#[test]
fn values_are_cleaned_everywhere() {
    let value = clean_value(
        json!({"a\x1b": ["x\x1b[0m", {"note": "password=1"}], "n": 3}),
        64,
    );
    assert_eq!(
        value,
        json!({"a\\x1b": ["x\\x1b[0m", {"note": "password=[redacted]"}], "n": 3})
    );
}

// ---------------------------------------------------------------- B-9

use super::super::template_tests::{
    Lab, OWNER, base, create, fence, plenty, pull, reason, reference,
};
use super::super::{Arc, Entry, Live, policy};
use std::{collections::BTreeMap, path::PathBuf};
use tokio::sync::watch;

const PH: &str = "cube_ph_github_AbCdEfGhIjKlMnOpQrStUv";
const TOKEN: &str = "ghp_0123456789abcdefABCDEF0123456789";
const MACHINE: &str = "00000000000000d1";

#[test]
fn placeholders_are_redacted_and_their_name_stays() {
    for (text, expected) in [
        // As the value of a token: the value goes whole.
        (
            format!("GH_TOKEN={PH}\n"),
            "GH_TOKEN=[redacted]\n".to_owned(),
        ),
        (
            format!("echo {PH}\n"),
            "echo cube_ph_github_[redacted]\n".to_owned(),
        ),
        // Glued to other text, in a URL, cut short.
        (
            format!("https://x:{PH}@github.com"),
            "https://x:cube_ph_github_[redacted]@github.com".into(),
        ),
        (format!("xx{PH}yy"), "xxcube_ph_github_[redacted]".into()),
        ("cube_ph_githu".into(), "cube_ph_[redacted]".into()),
        ("cube_ph_".into(), "cube_ph_".into()),
    ] {
        let redacted = redact(&text);
        assert_eq!(redacted, expected, "{text}");
        assert_eq!(redact(&redacted), redacted, "idempotent");
    }
    let (cleaned, _) = clean(format!("a\x1b[1m{PH}\x1b[0m b").as_bytes(), 4096);
    assert!(!cleaned.contains("AbCdEf"), "{cleaned}");
    assert_eq!(
        clean_value(json!({ PH: [PH] }), 64),
        json!({ "cube_ph_github_[redacted]": ["cube_ph_github_[redacted]"] })
    );
}

#[test]
fn a_logs_tail_is_bounded_cleaned_and_says_what_it_left_out() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("console.log");
    assert_eq!(log_tail(&log, 8), json!({ "present": false }));
    std::fs::create_dir(dir.path().join("a-dir")).unwrap();
    assert_eq!(
        log_tail(&dir.path().join("a-dir"), 8),
        json!({ "present": false })
    );
    std::fs::write(&log, b"0123456789\x1b[2Jabcdefgh").unwrap();
    let tail = log_tail(&log, 8);
    assert_eq!(tail["bytes"], 22);
    assert_eq!(tail["omittedBytes"], 14);
    assert_eq!(tail["complete"], false);
    assert_eq!(tail["text"], "abcdefgh");
    assert!(tail["modifiedAt"].is_string());
    let whole = log_tail(&log, 64);
    assert_eq!(whole["complete"], true);
    assert_eq!(whole["text"], "0123456789\\x1b[2Jabcdefgh");
    // A key whose BEGIN is before the tail.
    let lines = body(8);
    std::fs::write(
        &log,
        format!(
            "boot\n-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----\nlogin:\n",
            lines.join("\n")
        ),
    )
    .unwrap();
    let tail = log_tail(&log, 300);
    let text = tail["text"].as_str().unwrap();
    assert_no_body(text, &lines);
    assert!(text.ends_with("login:\n"), "{text}");
    // Its bound holds whatever the file holds.
    std::fs::write(&log, vec![0x1bu8; 1 << 20]).unwrap();
    let tail = log_tail(&log, CONSOLE_TAIL);
    assert!(tail["text"].as_str().unwrap().len() <= 4 * CONSOLE_TAIL as usize + 64);
    assert_eq!(tail["omittedBytes"], (1u64 << 20) - CONSOLE_TAIL);
}

#[test]
fn the_newest_events_are_shown_cleaned_and_a_cut_first_line_is_left_out() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("events.log");
    assert_eq!(event_lines(&log), json!({ "present": false }));
    let mut text = String::new();
    for n in 0..EVENTS_RETURNED + 7 {
        text.push_str(&format!("\"2026-10-14T00:00:00Z\" tick: n={n} \x1b[31m\n"));
    }
    text.push_str(&format!(
        "\"2026-10-14T00:00:01Z\" leak: token={TOKEN} {PH}\n"
    ));
    text.push_str(&format!(
        "\"2026-10-14T00:00:02Z\" long: {}\n",
        "x".repeat(4000)
    ));
    std::fs::write(&log, &text).unwrap();
    let events = event_lines(&log);
    let lines = events["lines"].as_array().unwrap();
    assert_eq!(lines.len(), EVENTS_RETURNED);
    assert_eq!(events["omittedLines"], 9);
    assert_eq!(events["omittedBytes"], 0);
    let shown = serde_json::to_string(lines).unwrap();
    assert!(
        !shown.contains("0123456789abcdef") && !shown.contains("AbCdEf"),
        "{shown}"
    );
    assert!(shown.contains("\\\\x1b[31m"), "escaped: {shown}");
    assert_eq!(
        lines.last().unwrap().as_str().unwrap().len(),
        EVENT_LINE_BYTES
    );
    assert!(
        lines[lines.len() - 2]
            .as_str()
            .unwrap()
            .contains("token=[redacted]")
    );
    // Longer than the window: its first, cut line is not shown.
    let big: String = (0..5000)
        .map(|n| format!("\"2026-10-14T00:00:00Z\" tick: {n:05} padding padding padding\n"))
        .collect();
    std::fs::write(&log, &big).unwrap();
    let events = event_lines(&log);
    let lines = events["lines"].as_array().unwrap();
    assert_eq!(lines.len(), EVENTS_RETURNED);
    assert!(
        lines
            .iter()
            .all(|l| l.as_str().unwrap().starts_with("\"2026-10-14"))
    );
    assert_eq!(
        lines.last().unwrap().as_str().unwrap(),
        "\"2026-10-14T00:00:00Z\" tick: 04999 padding padding padding"
    );
    let shown_bytes: u64 = events["omittedBytes"].as_u64().unwrap();
    assert!(
        shown_bytes > big.len() as u64 - EVENTS_TAIL,
        "{shown_bytes}"
    );
}

#[test]
fn a_document_too_large_drops_its_logs_first_and_never_exceeds_the_bound() {
    let small = json!({
        "version": VERSION,
        "collectedAt": "t",
        "machine": { "ref": { "owner": OWNER, "id": MACHINE }, "phase": "running" },
        "console": { "text": "c" },
        "events": { "lines": ["e"] },
        "qemu": { "log": { "text": "q" }, "argv": { "args": ["a"] } },
    });
    let text = bound(small.clone());
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["bounds"]["dropped"], json!([]));
    assert_eq!(value["console"]["text"], "c");
    // A console alone too large: only it goes.
    let mut large = small.clone();
    large["console"]["text"] = "c".repeat(MAX_DIAGNOSIS_BYTES).into();
    let value: Value = serde_json::from_str(&bound(large)).unwrap();
    assert_eq!(value["bounds"]["dropped"], json!(["/console/text"]));
    assert_eq!(value["console"]["text"], DROPPED);
    assert_eq!(value["events"]["lines"], json!(["e"]));
    // Console and events: both, in that order.
    let mut larger = small.clone();
    larger["console"]["text"] = "c".repeat(MAX_DIAGNOSIS_BYTES / 2).into();
    larger["events"]["lines"] = json!(vec!["e".repeat(1024); 260]);
    let text = bound(larger);
    assert!(text.len() <= MAX_DIAGNOSIS_BYTES);
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        value["bounds"]["dropped"],
        json!(["/console/text", "/events/lines"])
    );
    // Something no part accounts for: the reference and the phase are left.
    let mut huge = small;
    huge["machine"]["error"] = "x".repeat(MAX_DIAGNOSIS_BYTES).into();
    let text = bound(huge);
    assert!(text.len() <= MAX_DIAGNOSIS_BYTES);
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(
        value["machine"],
        json!({ "ref": { "owner": OWNER, "id": MACHINE }, "phase": "running" })
    );
    assert_eq!(value["bounds"]["dropped"], json!(["everything else"]));
}

/// Every file under `dir`: its size, change time and bytes' digest, and
/// the cache's use times through them (a diagnosis touches none).
fn tree(dir: &Path) -> BTreeMap<PathBuf, (u64, std::time::SystemTime, String)> {
    let mut files = BTreeMap::new();
    let mut todo = vec![dir.to_owned()];
    while let Some(dir) = todo.pop() {
        for entry in std::fs::read_dir(&dir).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                todo.push(entry.path());
            } else if kind.is_file() {
                let metadata = entry.metadata().unwrap();
                files.insert(
                    entry.path(),
                    (
                        metadata.len(),
                        metadata.modified().unwrap(),
                        qemu::sha256_file(&entry.path()).unwrap(),
                    ),
                );
            }
        }
    }
    files
}

async fn diagnose(runner: &Arc<VmRunner>, epoch: i64) -> Answer<Value> {
    let request = proto::MachineRef {
        r#ref: Some(reference(MACHINE)),
        fence: fence(epoch),
    };
    let diagnosis = runner.diagnose(request).await?;
    assert!(diagnosis.json.len() <= MAX_DIAGNOSIS_BYTES);
    Ok(serde_json::from_str(&diagnosis.json).unwrap())
}

#[tokio::test]
async fn a_diagnosis_is_fenced_and_owned_but_never_raises_the_epoch() {
    let lab = Lab::new();
    let runner = lab
        .runner(pull(lab.path(), 1, &[1]), u64::MAX, plenty)
        .await;
    create(&runner, MACHINE, base(), false).await.unwrap();
    // The machine is at epoch 1; cubed moves it to 5 with a mutation.
    {
        let mut state = runner.state.lock().unwrap();
        VmRunner::fenced(&mut state, Some(&reference(MACHINE)), fence(5).as_ref()).unwrap();
    }
    let ask = |r: Option<proto::Ref>, epoch: i64| {
        let runner = Arc::clone(&runner);
        async move {
            runner
                .diagnose(proto::MachineRef {
                    r#ref: r,
                    fence: fence(epoch),
                })
                .await
        }
    };
    assert_eq!(
        reason(ask(None, 5).await.unwrap_err()),
        (Code::InvalidArgument, "ref".into())
    );
    assert_eq!(
        reason(ask(Some(reference(MACHINE)), 0).await.unwrap_err()),
        (Code::InvalidArgument, "fence".into())
    );
    assert_eq!(
        reason(ask(Some(reference(MACHINE)), 4).await.unwrap_err()),
        (Code::FailedPrecondition, "stale_epoch".into())
    );
    let other = proto::Ref {
        owner: "thread-2".into(),
        id: MACHINE.into(),
    };
    assert_eq!(
        reason(ask(Some(other), 9).await.unwrap_err()),
        (Code::NotFound, "machine".into())
    );
    let unknown = proto::Ref {
        owner: OWNER.into(),
        id: "00000000000000ee".into(),
    };
    assert_eq!(
        reason(ask(Some(unknown), 9).await.unwrap_err()),
        (Code::NotFound, "machine".into())
    );
    // The same epoch and a newer one answer; the newer one is not taken.
    let record = std::fs::read(
        runner
            .machine_dir(MACHINE)
            .join(super::super::record::RECORD),
    )
    .unwrap();
    for epoch in [5, 9] {
        let document = diagnose(&runner, epoch).await.unwrap();
        assert_eq!(document["machine"]["fenceEpoch"], 5);
    }
    assert_eq!(
        runner.state.lock().unwrap().machines[MACHINE]
            .record
            .fence_epoch,
        5
    );
    assert_eq!(
        std::fs::read(
            runner
                .machine_dir(MACHINE)
                .join(super::super::record::RECORD)
        )
        .unwrap(),
        record,
        "the record on disk is as it was"
    );
    // A deleted machine is refused as a mutation refuses it.
    {
        let mut state = runner.state.lock().unwrap();
        runner.remove(&mut state, MACHINE).unwrap();
    }
    assert_eq!(
        reason(ask(Some(reference(MACHINE)), 9).await.unwrap_err()),
        (Code::FailedPrecondition, "deleted".into())
    );
}

#[tokio::test]
async fn a_stopped_machine_says_what_is_missing_and_nothing_changes() {
    let lab = Lab::new();
    let runner = lab
        .runner(pull(lab.path(), 1, &[1, 2]), u64::MAX, plenty)
        .await;
    create(&runner, MACHINE, base(), false).await.unwrap();
    let before = tree(lab.path());
    let version = runner.state.lock().unwrap().version;
    let mut watching = runner.events.subscribe();
    let document = diagnose(&runner, 1).await.unwrap();
    assert_eq!(document["version"], VERSION);
    let machine = &document["machine"];
    assert_eq!(machine["phase"], "stopped");
    assert_eq!(machine["ref"], json!({ "owner": OWNER, "id": MACHINE }));
    assert_eq!(machine["bootId"], Value::Null);
    assert_eq!(machine["newestBoot"], Value::Null);
    assert_eq!(machine["build"], false);
    assert_eq!(machine["templateId"], Value::Null);
    // Its layers topmost first, each with its file in the cache.
    let layers = machine["layers"].as_array().unwrap();
    assert_eq!(layers.len(), 2);
    assert_eq!(layers[0]["partition"], 2);
    assert_eq!(layers[0]["source"]["diffId"], diff_id_text(2));
    assert_eq!(layers[0]["present"]["bytes"], 4096);
    assert_eq!(machine["files"]["rw.qcow2"]["bytes"], 0);
    assert_eq!(machine["files"]["argv.json"], Value::Null);
    // QEMU: path and version (A17), no process, no recorded argv.
    let qemu = &document["qemu"];
    assert_eq!(qemu["path"], "/nonexistent/qemu");
    assert_eq!(qemu["version"], "11.1.2");
    assert_eq!(qemu["machineType"], "pc-q35-11.1");
    assert_eq!(qemu["accelerator"], "tcg");
    assert_eq!(
        (qemu["pid"].clone(), qemu["running"].clone()),
        (Value::Null, json!(false))
    );
    assert_eq!(qemu["argv"]["present"], false);
    assert!(
        qemu["argv"]["reason"]
            .as_str()
            .unwrap()
            .contains("never started")
    );
    assert_eq!(qemu["log"], json!({ "present": false }));
    // Nothing asked of QMP or the agent, and why.
    assert_eq!(document["qmp"]["asked"], false);
    assert_eq!(document["qmp"]["status"], Value::Null);
    assert_eq!(
        document["qmp"]["reason"],
        "the machine is stopped: no QEMU runs"
    );
    assert_eq!(document["guest"]["info"], Value::Null);
    assert!(
        document["guest"]["reason"]
            .as_str()
            .unwrap()
            .contains("stopped")
    );
    assert_eq!(document["console"]["present"], false);
    assert_eq!(document["events"]["present"], true);
    assert!(
        document["events"]["lines"][0]
            .as_str()
            .unwrap()
            .contains("created: machine type pc-q35-11.1")
    );
    // No start since the runner started: no policy, said so.
    assert_eq!(document["egress"]["policy"]["summary"], Value::Null);
    assert!(
        document["egress"]["policy"]["reason"]
            .as_str()
            .unwrap()
            .contains("memory only")
    );
    assert_eq!(document["egress"]["refusals"]["total"], 0);
    assert_eq!(document["egress"]["lease"]["cubedConnections"], 0);
    // No cubed in process: no paths, no RTT.
    assert_eq!(document["iroh"]["configuredMode"], "loopback");
    assert_eq!(document["iroh"]["connections"], json!([]));
    assert_eq!(document["iroh"]["rttToCubedMs"], Value::Null);
    let runner_facts = &document["runner"];
    assert_eq!(
        runner_facts["machines"],
        json!({ "count": 1, "running": 0, "max": 8 })
    );
    assert_eq!(runner_facts["layerCache"]["layers"], 2);
    assert_eq!(runner_facts["freeBytes"], u64::MAX);
    assert_eq!(document["bounds"]["dropped"], json!([]));
    // Nothing changed: no file, no use time of the cache, no version, no event.
    assert_eq!(tree(lab.path()), before);
    assert_eq!(runner.state.lock().unwrap().version, version);
    assert!(matches!(
        watching.try_recv(),
        Err(tokio::sync::broadcast::error::TryRecvError::Empty)
    ));
}

fn diff_id_text(n: u8) -> String {
    keel_layers::DiffId::from_bytes([n; 32]).to_string()
}

/// A stand-in for the machine's QMP socket: `greet` false accepts and
/// never says anything. Answers `query-status` as a running QEMU does.
fn fake_qmp(socket: &Path, greet: bool) -> tokio::task::JoinHandle<Vec<String>> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    let listener = tokio::net::UnixListener::bind(socket).unwrap();
    tokio::spawn(async move {
        let mut asked = Vec::new();
        let Ok((stream, _)) = listener.accept().await else {
            return asked;
        };
        if !greet {
            tokio::time::sleep(Duration::from_secs(30)).await;
            return asked;
        }
        let (read, mut write) = stream.into_split();
        let mut lines = BufReader::new(read).lines();
        write
            .write_all(b"{\"QMP\": {\"version\": {}, \"capabilities\": []}}\n")
            .await
            .unwrap();
        while let Ok(Some(line)) = lines.next_line().await {
            let command: Value = serde_json::from_str(&line).unwrap();
            let command = command["execute"].as_str().unwrap().to_owned();
            let answer = match command.as_str() {
                "query-status" => json!({ "return": { "status": "running", "running": true } }),
                _ => json!({ "return": {} }),
            };
            asked.push(command);
            write
                .write_all(format!("{answer}\n").as_bytes())
                .await
                .unwrap();
        }
        asked
    })
}

/// A process that stands in for a machine's QEMU, ended when dropped.
struct StandIn {
    exited: watch::Sender<bool>,
    child: std::process::Child,
}

impl Drop for StandIn {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

/// The machine as if its QEMU ran (a `sleep` stands in for it): running,
/// with what its agent said and the policy of its start.
fn as_running(runner: &VmRunner) -> StandIn {
    let (exited_tx, exited) = watch::channel(false);
    let child = std::process::Command::new("sleep")
        .arg("120")
        .spawn()
        .unwrap();
    let pid = child.id();
    let mut state = runner.state.lock().unwrap();
    let entry: &mut Entry = state.machines.get_mut(MACHINE).unwrap();
    entry.live = Some(Live { pid, exited });
    entry.record.phase = Phase::Running;
    entry.record.boot = Some(super::super::record::Boot {
        boot_id: "b".repeat(32),
        started_at: Timestamp::now(),
        pid,
        qemu: "11.1.2 /nonexistent/qemu".into(),
        kernel_sha256: "k".into(),
        base_sha256: "b".into(),
    });
    entry.info = Some(proto::GuestInfo {
        connected: true,
        ready: true,
        os: format!("keel \x1b]0;title\x07 {PH}"),
        session: "s".repeat(32),
        hooks: [(format!("pre-setup {PH}"), "ok".to_owned())].into(),
        ..Default::default()
    });
    entry.policy = Some(
        policy::Policy::from_proto(Some(&proto::EgressPolicy {
            default: proto::egress_policy::Default::Deny as i32,
            deny_hosts: vec!["*.internal".into()],
            rules: vec![proto::egress_policy::Rule {
                hosts: vec!["github.com".into(), "*.github.com".into()],
                ports: vec![],
                kind: Some(proto::egress_policy::rule::Kind::Https(
                    proto::egress_policy::Https {
                        credential: Some(proto::egress_policy::Credential {
                            name: "github".into(),
                        }),
                    },
                )),
            }],
            lease: Some(pbjson_types::Duration {
                seconds: 900,
                nanos: 0,
            }),
        }))
        .unwrap(),
    );
    StandIn {
        exited: exited_tx,
        child,
    }
}

#[tokio::test]
async fn a_running_machine_shows_qmp_its_agent_its_egress_and_its_logs_redacted() {
    let lab = Lab::new();
    let runner = lab
        .runner(pull(lab.path(), 1, &[1]), u64::MAX, plenty)
        .await;
    create(&runner, MACHINE, base(), false).await.unwrap();
    let dir = runner.machine_dir(MACHINE);
    let _qemu = as_running(&runner);
    std::fs::write(
        dir.join("argv.json"),
        serde_json::to_vec(
            &json!({ "qemu": "/nonexistent/qemu", "args": ["-machine", "pc-q35-11.1,accel=tcg"] }),
        )
        .unwrap(),
    )
    .unwrap();
    let key = body(4);
    std::fs::write(
        dir.join(qemu::CONSOLE),
        format!(
            "[    0.1] keel\x1b[2J\r\nGH_TOKEN={PH}\nAuthorization: Bearer {TOKEN}\n-----BEGIN OPENSSH PRIVATE KEY-----\n{}\n-----END OPENSSH PRIVATE KEY-----\nready\n",
            key.join("\n")
        ),
    )
    .unwrap();
    std::fs::write(
        dir.join("qemu.log"),
        format!("--- boot b: 11.1.2\nqemu: token={TOKEN}\n"),
    )
    .unwrap();
    for (host, reason) in [
        (format!("{PH}.example"), "placeholder"),
        ("deny.internal".into(), "deny_host"),
    ] {
        runner
            .egress
            .reports
            .push(&reference(MACHINE), &host, reason);
    }
    let asked = fake_qmp(&dir.join(qemu::QMP_SOCKET), true);
    let before = tree(lab.path());
    let document = diagnose(&runner, 1).await.unwrap();
    assert_eq!(tree(lab.path()), before, "nothing written");
    let text = document.to_string();
    for secret in [PH, "AbCdEfGhIj", "0123456789abcdef", &key[1][..16]] {
        assert!(!text.contains(secret), "{secret} in {text}");
    }
    assert!(
        !text.contains('\u{1b}') && !text.contains('\u{7}'),
        "{text}"
    );
    assert_eq!(document["machine"]["phase"], "running");
    assert_eq!(document["machine"]["bootId"], "b".repeat(32));
    assert_eq!(document["machine"]["newestBoot"]["current"], true);
    assert_eq!(document["qemu"]["running"], true);
    assert_eq!(document["qemu"]["pid"], _qemu.child.id());
    assert_eq!(document["qemu"]["argv"]["present"], true);
    assert_eq!(document["qemu"]["argv"]["current"], true);
    assert_eq!(document["qemu"]["argv"]["args"][1], "pc-q35-11.1,accel=tcg");
    assert!(
        document["qemu"]["log"]["text"]
            .as_str()
            .unwrap()
            .contains("token=[redacted]")
    );
    // QMP: query-status alone, within its budget.
    assert_eq!(document["qmp"]["asked"], true);
    assert_eq!(
        document["qmp"]["status"],
        json!({ "status": "running", "running": true })
    );
    assert_eq!(asked.await.unwrap(), ["qmp_capabilities", "query-status"]);
    // What the agent said, cleaned (also the keys of its hooks).
    let info = &document["guest"]["info"];
    assert_eq!(info["ready"], true);
    assert_eq!(
        info["os"],
        "keel \\x1b]0;title\\x07 cube_ph_github_[redacted]"
    );
    assert_eq!(info["hooks"]["pre-setup cube_ph_github_[redacted]"], "ok");
    // The console: its newest boot's, redacted.
    let console = &document["console"];
    assert_eq!(
        (console["present"].clone(), console["current"].clone()),
        (json!(true), json!(true))
    );
    assert_eq!(console["bootId"], "b".repeat(32));
    let console = console["text"].as_str().unwrap();
    assert!(
        console.contains("[redacted private key]") && console.ends_with("ready\n"),
        "{console}"
    );
    assert!(console.contains("GH_TOKEN=[redacted]\n"), "{console}");
    // Egress: the policy as a summary, the lease, the newest refusals.
    let egress = &document["egress"];
    assert_eq!(egress["policy"]["current"], true);
    let summary = &egress["policy"]["summary"];
    assert_eq!(summary["default"], "deny");
    assert_eq!(summary["leaseSeconds"], 900.0);
    assert_eq!(
        summary["denyHosts"],
        json!({ "count": 1, "shown": ["*.internal"] })
    );
    assert_eq!(summary["rules"]["shown"][0]["credential"], "github");
    assert_eq!(
        summary["rules"]["shown"][0]["hosts"]["shown"],
        json!(["github.com", "*.github.com"])
    );
    assert_eq!(egress["lease"]["leaseSeconds"], 900.0);
    assert_eq!(egress["lease"]["expired"], false);
    assert_eq!(egress["refusals"]["total"], 2);
    let newest = egress["refusals"]["newest"].as_array().unwrap();
    assert_eq!(newest[0]["host"], "cube_ph_github_[redacted].example");
    assert_eq!(newest[1]["reason"], "deny_host");
}

#[tokio::test]
async fn a_qmp_that_does_not_answer_is_said_within_the_budget() {
    let lab = Lab::new();
    let runner = lab
        .runner(pull(lab.path(), 1, &[1]), u64::MAX, plenty)
        .await;
    create(&runner, MACHINE, base(), false).await.unwrap();
    let _qemu = as_running(&runner);
    // No socket at all: tried for the budget, then why.
    let started = std::time::Instant::now();
    let document = diagnose(&runner, 1).await.unwrap();
    assert!(
        started.elapsed() < QMP_BUDGET * 3,
        "{:?}",
        started.elapsed()
    );
    assert_eq!(document["qmp"]["asked"], true);
    assert_eq!(document["qmp"]["status"], Value::Null);
    let reason = document["qmp"]["reason"].as_str().unwrap();
    assert!(
        reason.starts_with("QMP: connect ") || reason.contains("did not answer within 1000 ms"),
        "{reason}"
    );
    // A socket that takes the connection and never greets (busy).
    let _silent = fake_qmp(&runner.machine_dir(MACHINE).join(qemu::QMP_SOCKET), false);
    let started = std::time::Instant::now();
    let document = diagnose(&runner, 1).await.unwrap();
    let took = started.elapsed();
    assert!(took >= QMP_BUDGET && took < QMP_BUDGET * 3, "{took:?}");
    assert!(
        document["qmp"]["reason"]
            .as_str()
            .unwrap()
            .contains("did not answer within 1000 ms")
    );
    // The agent has said nothing in this boot yet.
    runner
        .state
        .lock()
        .unwrap()
        .machines
        .get_mut(MACHINE)
        .unwrap()
        .info = None;
    let document = diagnose(&runner, 1).await.unwrap();
    assert_eq!(document["guest"]["info"], Value::Null);
    assert_eq!(
        document["guest"]["reason"],
        "the runner has no guest channel for this QEMU"
    );
}

#[tokio::test]
async fn a_machine_whose_qemu_exited_says_its_evidence_is_from_the_last_boot() {
    let lab = Lab::new();
    let runner = lab
        .runner(pull(lab.path(), 1, &[1]), u64::MAX, plenty)
        .await;
    create(&runner, MACHINE, base(), false).await.unwrap();
    let dir = runner.machine_dir(MACHINE);
    let qemu_exited = as_running(&runner);
    std::fs::write(dir.join("argv.json"), b"{\"qemu\": \"/q\", \"args\": []}").unwrap();
    std::fs::write(dir.join(qemu::CONSOLE), b"kernel panic\n").unwrap();
    // The reaper saw it go; the runner records it as stopped with an error.
    qemu_exited.exited.send(true).unwrap();
    {
        let mut state = runner.state.lock().unwrap();
        let entry = state.machines.get_mut(MACHINE).unwrap();
        entry.live = None;
        entry.info = None;
        entry.record.phase = Phase::Stopped;
        entry.record.error = format!("QEMU exited (signal: 9): boot {PH}");
    }
    let document = diagnose(&runner, 1).await.unwrap();
    assert_eq!(document["machine"]["phase"], "stopped");
    assert_eq!(
        document["machine"]["error"],
        "QEMU exited (signal: 9): boot cube_ph_github_[redacted]"
    );
    assert_eq!(document["machine"]["bootId"], Value::Null);
    assert_eq!(document["machine"]["newestBoot"]["current"], false);
    assert_eq!(document["qemu"]["argv"]["present"], true);
    assert_eq!(document["qemu"]["argv"]["current"], false);
    assert_eq!(document["console"]["current"], false);
    assert_eq!(document["console"]["text"], "kernel panic\n");
    assert_eq!(document["qmp"]["asked"], false);
    // The policy of its last start is kept, not current.
    assert_eq!(document["egress"]["policy"]["current"], false);
    assert_eq!(document["egress"]["policy"]["summary"]["default"], "deny");
    // An argv.json that is not the runner's.
    std::fs::write(dir.join("argv.json"), b"not json").unwrap();
    let document = diagnose(&runner, 1).await.unwrap();
    assert_eq!(document["qemu"]["argv"]["present"], false);
    assert!(
        document["qemu"]["argv"]["reason"]
            .as_str()
            .unwrap()
            .contains("not the runner's record")
    );
}

#[tokio::test]
async fn a_machine_with_large_logs_stays_within_the_bound() {
    let lab = Lab::new();
    let runner = lab
        .runner(pull(lab.path(), 1, &[1]), u64::MAX, plenty)
        .await;
    create(&runner, MACHINE, base(), false).await.unwrap();
    let dir = runner.machine_dir(MACHINE);
    // Every byte escapes fourfold: the logs' own bounds add up past the
    // document's, so the console goes first.
    std::fs::write(dir.join(qemu::CONSOLE), vec![0x01u8; 4 << 20]).unwrap();
    std::fs::write(dir.join("qemu.log"), vec![0x02u8; 1 << 20]).unwrap();
    let lines: String = (0..2000)
        .map(|_| format!("{}\n", "\x03".repeat(600)))
        .collect();
    std::fs::write(dir.join("events.log"), lines).unwrap();
    for n in 0..100 {
        runner.egress.reports.push(
            &reference(MACHINE),
            &format!("{}{n}.example", "h".repeat(240)),
            "policy",
        );
    }
    let diagnosis = runner
        .diagnose(proto::MachineRef {
            r#ref: Some(reference(MACHINE)),
            fence: fence(1),
        })
        .await
        .unwrap();
    assert!(
        diagnosis.json.len() <= MAX_DIAGNOSIS_BYTES,
        "{}",
        diagnosis.json.len()
    );
    let document: Value = serde_json::from_str(&diagnosis.json).unwrap();
    let dropped = document["bounds"]["dropped"].as_array().unwrap();
    assert_eq!(dropped[0], "/console/text");
    assert_eq!(document["console"]["text"], DROPPED);
    assert_eq!(
        document["console"]["omittedBytes"],
        (4u64 << 20) - CONSOLE_TAIL
    );
    assert_eq!(
        document["egress"]["refusals"]["newest"]
            .as_array()
            .map(Vec::len),
        Some(super::super::report::RECENT)
    );
    assert_eq!(document["egress"]["refusals"]["total"], 100);
}

/// What runner-vm-test.ts has the guest write to its console (B-9), as
/// the serial console stores it (`\r\n`): its expected text here.
#[test]
fn the_native_gates_planted_console_is_redacted_as_it_expects() {
    let dir = tempfile::tempdir().unwrap();
    let log = dir.path().join("console.log");
    let fake = format!("ghp_{}", "b9".repeat(12));
    let mut planted = vec![b'x'; 300_000];
    planted.extend(
        format!(
            "\r\nb9-plant {PH} {fake} password=hunter2b9\r\n-----BEGIN OPENSSH PRIVATE KEY-----\r\nb3BlbnNzaC1rZXktdjEAAAABbm9uZQ\r\n-----END OPENSSH PRIVATE KEY-----\r\nb9-end\r\n"
        )
        .bytes(),
    );
    std::fs::write(&log, &planted).unwrap();
    let tail = log_tail(&log, CONSOLE_TAIL);
    let text = tail["text"].as_str().unwrap();
    assert!(
        text.ends_with("\nb9-plant cube_ph_github_[redacted] ghp_[redacted] password=[redacted]\n[redacted private key]\nb9-end\n"),
        "{}",
        &text[text.len() - 200..]
    );
    assert_eq!(tail["omittedBytes"], planted.len() as u64 - CONSOLE_TAIL);
}
