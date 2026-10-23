use std::{
    cell::RefCell,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

use super::*;

fn utf(out: &mut Vec<u8>, text: &str) {
    out.extend_from_slice(&(text.len() as u16).to_be_bytes());
    out.extend_from_slice(text.as_bytes());
}

/// A JKS as the JDK writes one (the digest is zeros: the parser does not
/// check it): trusted entries, and `keys` private key entries with a chain.
fn jks(version: u32, trusted: &[(&str, &[u8])], keys: usize) -> Vec<u8> {
    let mut out = vec![0xfe, 0xed, 0xfe, 0xed];
    out.extend_from_slice(&version.to_be_bytes());
    out.extend_from_slice(&((trusted.len() + keys) as u32).to_be_bytes());
    let certificate = |out: &mut Vec<u8>, der: &[u8]| {
        if version == 2 {
            utf(out, "X.509");
        }
        out.extend_from_slice(&(der.len() as u32).to_be_bytes());
        out.extend_from_slice(der);
    };
    for i in 0..keys {
        out.extend_from_slice(&1u32.to_be_bytes());
        utf(&mut out, &format!("key{i}"));
        out.extend_from_slice(&0u64.to_be_bytes());
        out.extend_from_slice(&3u32.to_be_bytes());
        out.extend_from_slice(b"key");
        out.extend_from_slice(&2u32.to_be_bytes());
        certificate(&mut out, b"leaf");
        certificate(&mut out, b"issuer");
    }
    for (alias, der) in trusted {
        out.extend_from_slice(&2u32.to_be_bytes());
        utf(&mut out, alias);
        out.extend_from_slice(&1_700_000_000_000u64.to_be_bytes());
        certificate(&mut out, der);
    }
    out.extend_from_slice(&[0; 20]);
    out
}

fn pem(der: &[u8]) -> String {
    use base64::Engine;
    format!(
        "-----BEGIN CERTIFICATE-----\n{}\n-----END CERTIFICATE-----\n",
        base64::engine::general_purpose::STANDARD.encode(der)
    )
}

fn der_of(pem_text: &[u8]) -> Vec<u8> {
    generated::pem_certificates(pem_text).remove(0)
}

#[test]
fn a_jks_is_read_to_its_digest_and_nothing_else_passes_for_one() {
    for version in [1, 2] {
        let data = jks(
            version,
            &[("debian:a.pem", b"AAAA"), ("debian:b.pem", b"BB")],
            1,
        );
        assert_eq!(
            kind(&data),
            Kind::Jks(vec![
                ("debian:a.pem".into(), b"AAAA".to_vec()),
                ("debian:b.pem".into(), b"BB".to_vec())
            ]),
            "version {version}: the trusted entries, the key entry skipped"
        );
    }
    let data = jks(2, &[("debian:a.pem", b"AAAA")], 0);
    let other = |bytes: &[u8]| match kind(bytes) {
        Kind::Damaged(why) => format!("damaged: {why}"),
        Kind::Foreign(what) => format!("foreign: {what}"),
        found => panic!("{found:?}"),
    };
    assert!(other(&data[..data.len() - 1]).contains("not a 20-byte digest"));
    assert!(other(&[&data[..], b"x"].concat()).contains("21 bytes after"));
    assert!(other(&data[..30]).contains("cut off"));
    // The runner's CA after the magic is no keystore (the template test's
    // stand-in): left alone, never "repaired".
    assert!(
        other(&[&[0xfe, 0xed, 0xfe, 0xed][..], &[0x30, 0x82, 1, 2]].concat()).contains("version")
    );
    let mut wrong_type = jks(2, &[("a", b"AAAA")], 0);
    let at = 12 + 4 + 2 + 1 + 8 + 2;
    wrong_type[at..at + 5].copy_from_slice(b"X.510");
    assert!(other(&wrong_type).contains("X.510"));
    assert!(other(&data[..30]).starts_with("damaged: "));
    assert_eq!(
        other(&[0x30, 0x82, 0x01, 0x00]),
        "foreign: a PKCS#12 keystore"
    );
    assert_eq!(
        other(&[0xce, 0xce, 0xce, 0xce]),
        "foreign: a JCEKS keystore"
    );
    assert_eq!(other(b""), "damaged: an empty file");
    assert_eq!(
        other(b"-----BEGIN CERTIFICATE-----"),
        "foreign: not a keystore format cube knows"
    );
}

#[test]
fn the_defaults_are_read_as_plain_assignments_only() {
    assert_eq!(defaults(None), Ok(("changeit".into(), true)));
    let debian = "# enable/disable updates of the keystore /etc/ssl/certs/java/cacerts\ncacerts_updates=yes\n\n# Uncomment the following line to change the storepass\n#storepass='changeit'\n";
    assert_eq!(defaults(Some(debian)), Ok(("changeit".into(), true)));
    assert_eq!(
        defaults(Some("storepass='s3cret'\ncacerts_updates=\"no\"\n")),
        Ok(("s3cret".into(), false))
    );
    for shell in [
        "storepass=$(cat /root/pass)",
        "storepass=a b",
        "storepass=''",
        "cacerts_updates=`x`",
    ] {
        assert!(defaults(Some(shell)).is_err(), "{shell}");
    }
    assert_eq!(
        defaults(Some("other=$(x)\n")),
        Ok(("changeit".into(), true))
    );
}

/// A root with a keystore, a `keytool` on PATH and optional defaults.
struct Root {
    dir: tempfile::TempDir,
}

impl Root {
    fn new(keystore: &[u8]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = Self { dir };
        fs::create_dir_all(root.path().join("etc/ssl/certs/java")).unwrap();
        fs::write(root.keystore(), keystore).unwrap();
        fs::set_permissions(root.keystore(), fs::Permissions::from_mode(0o644)).unwrap();
        fs::create_dir_all(root.path().join("usr/bin")).unwrap();
        fs::write(root.path().join("usr/bin/keytool"), "#!/bin/sh\n").unwrap();
        fs::set_permissions(
            root.path().join("usr/bin/keytool"),
            fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        root
    }
    fn path(&self) -> &Path {
        self.dir.path()
    }
    fn keystore(&self) -> PathBuf {
        self.path().join(KEYSTORE)
    }
    fn file(&self) -> fs::File {
        fs::File::open(self.path()).unwrap()
    }
    /// The workload path `keytool` was given, in this root.
    fn host(&self, workload: &str) -> PathBuf {
        self.path().join(workload.trim_start_matches('/'))
    }
}

/// No namespace, no cgroup: a call in this test's own world.
const FREE: Confined = Confined {
    namespace: None,
    group: None,
};

fn arg<'a>(args: &'a [String], name: &str) -> &'a str {
    let at = args.iter().position(|a| a == name).unwrap();
    &args[at + 1]
}

/// keytool as a model: -delete and -importcert on the JKS at -keystore.
fn model(
    root: &Root,
    calls: &RefCell<Vec<String>>,
) -> impl FnMut(&[String], &[u8]) -> io::Result<Ran> {
    move |args, stdin| {
        assert_eq!(arg(args, "-storetype"), "JKS");
        assert_eq!(arg(args, "-storepass"), "changeit");
        assert!(args.contains(&"-noprompt".to_string()));
        let path = root.host(arg(args, "-keystore"));
        let Kind::Jks(mut entries) = kind(&fs::read(&path).unwrap()) else {
            panic!("not a JKS")
        };
        let alias = arg(args, "-alias").to_string();
        calls.borrow_mut().push(format!("{} {alias}", args[0]));
        match args[0].as_str() {
            "-delete" => entries.retain(|(a, _)| *a != alias),
            "-importcert" => entries.push((alias, der_of(stdin))),
            other => panic!("{other}"),
        }
        let trusted: Vec<(&str, &[u8])> = entries
            .iter()
            .map(|(a, d)| (a.as_str(), d.as_slice()))
            .collect();
        fs::write(&path, jks(2, &trusted, 0)).unwrap(); // in place, as keytool writes
        Ok(Ran {
            status: Some(0),
            timed_out: false,
            output: "Certificate was added to keystore".into(),
        })
    }
}

const CA: &[u8] = b"the runner's CA";

#[test]
fn a_keystore_without_the_ca_gets_it_and_keeps_its_roots() {
    let root = Root::new(&jks(
        2,
        &[
            ("debian:root-a.pem", b"ROOT-A"),
            ("debian:root-b.pem", b"ROOT-B"),
        ],
        0,
    ));
    let calls = RefCell::new(vec![]);
    let outcome = reconcile(&root.file(), &pem(CA), &mut model(&root, &calls)).unwrap();
    assert_eq!(outcome.word(), "repaired", "{outcome:?}");
    assert_eq!(
        outcome.detail(),
        "added the runner's CA to /etc/ssl/certs/java/cacerts; its 2 other certificates kept"
    );
    assert_eq!(*calls.borrow(), ["-importcert debian:cube-runner.pem"]);
    let after = fs::read(root.keystore()).unwrap();
    assert_eq!(
        kind(&after),
        Kind::Jks(vec![
            ("debian:root-a.pem".into(), b"ROOT-A".to_vec()),
            ("debian:root-b.pem".into(), b"ROOT-B".to_vec()),
            (ALIAS.into(), CA.to_vec()),
        ])
    );
    assert_eq!(
        fs::metadata(root.keystore()).unwrap().permissions().mode() & 0o7777,
        0o644,
        "its mode kept"
    );
    assert_eq!(
        fs::read_dir(root.keystore().parent().unwrap())
            .unwrap()
            .count(),
        1,
        "no copy left"
    );

    // Again: nothing to do, nothing written, keytool not run.
    let inode = fs::metadata(root.keystore()).unwrap().ino();
    let outcome = reconcile(&root.file(), &pem(CA), &mut model(&root, &calls)).unwrap();
    assert_eq!(outcome, Outcome::Ok);
    assert_eq!(calls.borrow().len(), 1);
    assert_eq!(fs::read(root.keystore()).unwrap(), after);
    assert_eq!(fs::metadata(root.keystore()).unwrap().ino(), inode);
}

#[test]
fn a_stale_ca_under_cube_s_alias_is_replaced() {
    let root = Root::new(&jks(
        2,
        &[
            ("debian:root-a.pem", b"ROOT-A"),
            (ALIAS, b"an older runner CA"),
        ],
        0,
    ));
    let calls = RefCell::new(vec![]);
    let outcome = reconcile(&root.file(), &pem(CA), &mut model(&root, &calls)).unwrap();
    assert_eq!(outcome.word(), "repaired");
    assert!(
        outcome
            .detail()
            .contains("in place of a stale one under its alias; its 1 other certificates kept"),
        "{}",
        outcome.detail()
    );
    assert_eq!(
        *calls.borrow(),
        [format!("-delete {ALIAS}"), format!("-importcert {ALIAS}")]
    );
    assert_eq!(
        kind(&fs::read(root.keystore()).unwrap()),
        Kind::Jks(vec![
            ("debian:root-a.pem".into(), b"ROOT-A".to_vec()),
            (ALIAS.into(), CA.to_vec())
        ])
    );
}

#[test]
fn a_repair_that_loses_roots_fails_or_stops_leaves_the_keystore_as_it_was() {
    let original = jks(
        2,
        &[
            ("debian:root-a.pem", b"ROOT-A"),
            ("debian:root-b.pem", b"ROOT-B"),
        ],
        0,
    );
    type Fake = Box<dyn Fn(&Root, &[String]) -> Ran>;
    let failing: [(&str, Fake); 4] = [
        (
            "lost 1 of the keystore's certificates",
            Box::new(|root, args| {
                // Imports the CA but drops a root.
                fs::write(
                    root.host(arg(args, "-keystore")),
                    jks(2, &[("debian:root-a.pem", b"ROOT-A"), (ALIAS, CA)], 0),
                )
                .unwrap();
                Ran {
                    status: Some(0),
                    timed_out: false,
                    output: String::new(),
                }
            }),
        ),
        (
            "lacks a certificate of the CA",
            Box::new(|_, _| Ran {
                status: Some(0),
                timed_out: false,
                output: String::new(),
            }),
        ),
        (
            "keytool -importcert exited 1: line 1 / line 2 / keytool error: java.lang.Exception: Input not an X.509 certificate",
            Box::new(|_, _| {
                Ran {
            status: Some(1),
            timed_out: false,
            output: "line 0\nline 1\nline 2\nkeytool error: java.lang.Exception: Input not an X.509 certificate\n".into(),
        }
            }),
        ),
        (
            "keytool -importcert took longer than 20 s",
            Box::new(|_, _| Ran {
                status: None,
                timed_out: true,
                output: String::new(),
            }),
        ),
    ];
    for (why, keytool) in failing {
        let root = Root::new(&original);
        let outcome = reconcile(&root.file(), &pem(CA), &mut |args: &[String], _: &[u8]| {
            Ok(keytool(&root, args))
        })
        .unwrap();
        assert_eq!(outcome.word(), "failed", "{why}");
        assert!(
            outcome.detail().starts_with(
                "/etc/ssl/certs/java/cacerts lacks the runner's CA and was left as it was: "
            ),
            "{}",
            outcome.detail()
        );
        assert!(
            outcome.detail().ends_with(why),
            "{} vs {why}",
            outcome.detail()
        );
        assert_eq!(fs::read(root.keystore()).unwrap(), original, "{why}");
        assert_eq!(
            fs::read_dir(root.keystore().parent().unwrap())
                .unwrap()
                .count(),
            1,
            "{why}: the copy removed"
        );
    }
    // keytool could not be started at all.
    let root = Root::new(&original);
    let outcome = reconcile(&root.file(), &pem(CA), &mut |_: &[String], _: &[u8]| {
        Err(io::Error::other("no /bin/sh"))
    })
    .unwrap();
    assert!(
        outcome
            .detail()
            .ends_with("keytool -importcert: no /bin/sh"),
        "{}",
        outcome.detail()
    );
    assert_eq!(fs::read(root.keystore()).unwrap(), original);
}

#[test]
fn an_opt_out_or_a_foreign_format_is_skipped_and_a_ca_cube_cannot_add_fails_untouched() {
    let mut never = |_: &[String], _: &[u8]| -> io::Result<Ran> { panic!("keytool must not run") };
    let roots = jks(2, &[("debian:root-a.pem", b"ROOT-A")], 0);

    let root = Root::new(&roots);
    fs::remove_file(root.keystore()).unwrap();
    assert_eq!(
        reconcile(&root.file(), &pem(CA), &mut never),
        None,
        "no keystore: no outcome"
    );

    let root = Root::new(&[0x30, 0x82, 0x01, 0x00]);
    let outcome = reconcile(&root.file(), &pem(CA), &mut never).unwrap();
    assert_eq!(outcome.word(), "skipped");
    assert!(outcome.detail().contains("PKCS#12"), "{}", outcome.detail());

    let root = Root::new(&roots);
    fs::remove_file(root.path().join("usr/bin/keytool")).unwrap();
    let outcome = reconcile(&root.file(), &pem(CA), &mut never).unwrap();
    assert_eq!(outcome.word(), "failed", "the CA is missing and stays so");
    assert_eq!(
        outcome.detail(),
        "/etc/ssl/certs/java/cacerts lacks the runner's CA and cube cannot add it: the machine has no keytool"
    );

    let root = Root::new(&roots);
    fs::create_dir_all(root.path().join("etc/default")).unwrap();
    fs::write(
        root.path().join("etc/default/cacerts"),
        "cacerts_updates=no\n",
    )
    .unwrap();
    let outcome = reconcile(&root.file(), &pem(CA), &mut never).unwrap();
    assert_eq!(outcome.word(), "skipped");
    assert!(
        outcome.detail().contains("updates are off"),
        "{}",
        outcome.detail()
    );
    fs::write(
        root.path().join("etc/default/cacerts"),
        "storepass=$(cat /root/p)\n",
    )
    .unwrap();
    let outcome = reconcile(&root.file(), &pem(CA), &mut never).unwrap();
    assert_eq!(outcome.word(), "failed");
    assert!(
        outcome.detail().contains("storepass is not a plain value"),
        "{}",
        outcome.detail()
    );
    assert_eq!(fs::read(root.keystore()).unwrap(), roots);

    // A directory where the keystore would be.
    let root = Root::new(&roots);
    fs::remove_file(root.keystore()).unwrap();
    fs::create_dir(root.keystore()).unwrap();
    assert_eq!(
        reconcile(&root.file(), &pem(CA), &mut never)
            .unwrap()
            .word(),
        "failed"
    );

    // A damaged JKS (the template test's stand-in: the CA after the magic):
    // Java cannot load it, so failed, and it is left as it is.
    let standin = [
        &[0xfe, 0xed, 0xfe, 0xed][..],
        b"\x30\x82\x01\x02 the runner's CA",
    ]
    .concat();
    let root = Root::new(&standin);
    let outcome = reconcile(&root.file(), &pem(CA), &mut never).unwrap();
    assert_eq!(outcome.word(), "failed");
    assert!(
        outcome.detail().contains("a damaged JKS keystore"),
        "{}",
        outcome.detail()
    );
    assert_eq!(fs::read(root.keystore()).unwrap(), standin);
}

#[test]
fn the_keystore_is_found_inside_the_root_through_its_links() {
    // /etc/ssl/certs/java → /opt/java-certs (absolute: the root's, never
    // this host's), and its storepass from the defaults.
    let root = Root::new(&jks(2, &[("debian:root-a.pem", b"ROOT-A")], 0));
    fs::create_dir_all(root.path().join("opt")).unwrap();
    fs::rename(
        root.path().join("etc/ssl/certs/java"),
        root.path().join("opt/java-certs"),
    )
    .unwrap();
    std::os::unix::fs::symlink("/opt/java-certs", root.path().join("etc/ssl/certs/java")).unwrap();
    fs::create_dir_all(root.path().join("etc/default")).unwrap();
    fs::write(
        root.path().join("etc/default/cacerts"),
        "cacerts_updates=yes\nstorepass='other'\n",
    )
    .unwrap();
    let mut seen = vec![];
    let outcome = reconcile(
        &root.file(),
        &pem(CA),
        &mut |args: &[String], stdin: &[u8]| {
            seen.push((
                arg(args, "-keystore").to_string(),
                arg(args, "-storepass").to_string(),
            ));
            let path = root.host(arg(args, "-keystore"));
            fs::write(
                &path,
                jks(
                    2,
                    &[("debian:root-a.pem", b"ROOT-A"), (ALIAS, &der_of(stdin))],
                    0,
                ),
            )
            .unwrap();
            Ok(Ran {
                status: Some(0),
                timed_out: false,
                output: String::new(),
            })
        },
    )
    .unwrap();
    assert_eq!(outcome.word(), "repaired");
    assert_eq!(
        seen,
        [(
            "/opt/java-certs/.cacerts.cube-new".to_string(),
            "other".to_string()
        )]
    );
    assert!(
        fs::symlink_metadata(root.path().join("etc/ssl/certs/java"))
            .unwrap()
            .file_type()
            .is_symlink(),
        "the link stays"
    );

    // The keystore itself a link (to another name): the file it names is
    // replaced, the link stays.
    let root = Root::new(&jks(2, &[("debian:root-a.pem", b"ROOT-A")], 0));
    fs::create_dir_all(root.path().join("opt/jks")).unwrap();
    fs::rename(root.keystore(), root.path().join("opt/jks/system.jks")).unwrap();
    std::os::unix::fs::symlink("/opt/jks/system.jks", root.keystore()).unwrap();
    let calls = RefCell::new(vec![]);
    let outcome = reconcile(&root.file(), &pem(CA), &mut model(&root, &calls)).unwrap();
    assert_eq!(outcome.word(), "repaired");
    assert!(
        fs::symlink_metadata(root.keystore())
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(
        kind(&fs::read(root.path().join("opt/jks/system.jks")).unwrap()),
        Kind::Jks(vec![
            ("debian:root-a.pem".into(), b"ROOT-A".to_vec()),
            (ALIAS.into(), CA.to_vec())
        ])
    );
    assert_eq!(
        fs::read_dir(root.path().join("opt/jks")).unwrap().count(),
        1,
        "no file of another name"
    );
}

#[test]
fn run_captures_output_feeds_input_and_kills_the_whole_group_on_time() {
    let ran = run(
        &FREE,
        "cat; echo err >&2; exit 3",
        &[],
        b"input\n",
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!((ran.status, ran.timed_out), (Some(3), false));
    assert_eq!(ran.output, "input\nerr\n");
    let ran = run(
        &FREE,
        "printf '%s|' \"$@\"; printf '%s' \"$PATH\"",
        &["a b".into(), "c".into()],
        b"",
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(ran.output, format!("a b|c|{}", crate::STANDARD_PATH));

    // A background child keeps the output pipe open: it goes with the group.
    let started = Instant::now();
    let ran = run(
        &FREE,
        "sleep 30 & echo started; sleep 30",
        &[],
        b"",
        Duration::from_millis(300),
    )
    .unwrap();
    assert!(ran.timed_out && ran.status.is_none(), "{ran:?}");
    assert_eq!(ran.output, "started\n");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "{:?}",
        started.elapsed()
    );
    // An exit that leaves a child running does not wait for it either.
    let started = Instant::now();
    let ran = run(
        &FREE,
        "sleep 30 & exit 0",
        &[],
        b"",
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(ran.status, Some(0));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

/// A process that left the call's process group and holds its output
/// (`setsid`) cannot hold the call: its output is waited for 2 s at most.
#[test]
fn an_escaped_process_holding_the_output_does_not_hold_the_call() {
    let started = Instant::now();
    let ran = run(
        &FREE,
        "setsid sleep 6 & sleep 0.3; echo started; exit 0",
        &[],
        b"",
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(ran.status, Some(0));
    assert!(ran.output.starts_with("started\n"), "{:?}", ran.output);
    assert!(
        ran.output
            .contains("still held open by a process outside the call"),
        "{:?}",
        ran.output
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
}

/// Needs root and a cgroup v2 filesystem (`sudo cargo test`; CI sets
/// CUBE_AGENT_ROOT_TESTS; CUBE_TEST_CGROUP names where, default
/// /sys/fs/cgroup): a process that left the process group is still in the
/// call's cgroup and is killed with it, and the cgroup is removed.
#[test]
fn an_escaped_process_is_killed_with_the_call_s_cgroup() {
    let parent = std::env::var("CUBE_TEST_CGROUP").unwrap_or_else(|_| "/sys/fs/cgroup".into());
    let parent = Path::new(&parent);
    if unsafe { libc::geteuid() } != 0 || !parent.join("cgroup.procs").exists() {
        assert!(
            std::env::var_os("CUBE_AGENT_ROOT_TESTS").is_none(),
            "CUBE_AGENT_ROOT_TESTS is set: run this test as root with a cgroup v2 filesystem"
        );
        eprintln!(
            "SKIP: an_escaped_process_is_killed_with_the_call_s_cgroup needs root and cgroup v2"
        );
        return;
    }
    let group = parent.join(format!("cube-keystore-test-{}", std::process::id()));
    let marker = tempfile::tempdir().unwrap();
    let pid_file = marker.path().join("pid");
    let started = Instant::now();
    let ran = run(
        &Confined { namespace: None, group: Some(&group) },
        "setsid sh -c 'echo $$ > \"$1\"; exec sleep 30' sh \"$1\" & sleep 0.3; echo started; exit 0",
        &[pid_file.to_string_lossy().into_owned()],
        b"",
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!(ran.status, Some(0));
    assert_eq!(
        ran.output, "started\n",
        "the escaped process was killed, so the output ended"
    );
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "{:?}",
        started.elapsed()
    );
    let pid: i32 = fs::read_to_string(&pid_file)
        .unwrap()
        .trim()
        .parse()
        .unwrap();
    std::thread::sleep(Duration::from_millis(100));
    assert!(
        !Path::new(&format!("/proc/{pid}")).exists()
            || fs::read_to_string(format!("/proc/{pid}/stat"))
                .is_ok_and(|stat| stat.contains(") Z ")),
        "the escaped sleep {pid} is gone"
    );
    assert!(!group.exists(), "the call's cgroup is removed");
}

/// Needs root (`sudo cargo test`; CI sets CUBE_AGENT_ROOT_TESTS): the
/// command enters the given mount namespace and starts at its root.
#[test]
fn run_enters_the_workload_namespace_at_its_root() {
    if unsafe { libc::geteuid() } != 0 {
        assert!(
            std::env::var_os("CUBE_AGENT_ROOT_TESTS").is_none(),
            "CUBE_AGENT_ROOT_TESTS is set: run this test as root"
        );
        eprintln!("SKIP: run_enters_the_workload_namespace_at_its_root needs root");
        return;
    }
    let namespace = fs::File::open("/proc/self/ns/mnt").unwrap();
    let ran = run(
        &Confined {
            namespace: Some(&namespace),
            group: None,
        },
        "pwd; id -u",
        &[],
        b"",
        Duration::from_secs(10),
    )
    .unwrap();
    assert_eq!((ran.status, ran.output.as_str()), (Some(0), "/\n0\n"));
    let not_a_namespace = fs::File::open("/").unwrap();
    assert!(
        run(
            &Confined {
                namespace: Some(&not_a_namespace),
                group: None
            },
            "true",
            &[],
            b"",
            Duration::from_secs(10)
        )
        .is_err()
    );
}

fn certificate(name: &str) -> String {
    use rcgen::{
        BasicConstraints, CertificateParams, DistinguishedName, DnType, IsCa, KeyPair,
        PKCS_ECDSA_P256_SHA256,
    };
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::CommonName, name);
    let mut params = CertificateParams::default();
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    params.self_signed(&key).unwrap().pem()
}

/// The JDK's own keytool, when this host has one (CI requires it with
/// CUBE_TEST_KEYTOOL=required): the parser reads what keytool writes, and
/// a repair with it adds the CA, keeps the roots, does nothing twice and
/// replaces a stale CA.
#[test]
fn the_jdk_s_keytool_repairs_a_real_keystore() {
    if run(
        &FREE,
        "command -v keytool",
        &[],
        b"",
        Duration::from_secs(10),
    )
    .map_or(true, |r| r.status != Some(0))
    {
        assert!(
            std::env::var("CUBE_TEST_KEYTOOL").as_deref() != Ok("required"),
            "CUBE_TEST_KEYTOOL=required and no keytool on PATH"
        );
        eprintln!("SKIP: the_jdk_s_keytool_repairs_a_real_keystore: no keytool on PATH");
        return;
    }
    let keytool_in = |root: &Path| {
        let root = root.to_path_buf();
        move |args: &[String], stdin: &[u8]| {
            let mut all = vec!["-J-Xmx64m".to_string()];
            all.extend(args.iter().map(|a| match a.strip_prefix('/') {
                Some(rest) if rest.starts_with("etc/") => {
                    root.join(rest).to_string_lossy().into_owned()
                }
                _ => a.clone(),
            }));
            run(
                &FREE,
                "exec keytool \"$@\"",
                &all,
                stdin,
                Duration::from_secs(60),
            )
        }
    };
    let root = Root::new(b"");
    fs::remove_file(root.keystore()).unwrap();
    let store = root.keystore().to_string_lossy().into_owned();
    for name in ["public root a", "public root b"] {
        let ran = run(
            &FREE,
            "exec keytool \"$@\"",
            &[
                "-importcert",
                "-noprompt",
                "-alias",
                &format!("debian:{}.pem", name.replace(' ', "_")),
                "-keystore",
                &store,
                "-storetype",
                "JKS",
                "-storepass",
                "changeit",
            ]
            .map(String::from),
            certificate(name).as_bytes(),
            Duration::from_secs(60),
        )
        .unwrap();
        assert_eq!(ran.status, Some(0), "{}", ran.output);
    }
    let Kind::Jks(before) = kind(&fs::read(root.keystore()).unwrap()) else {
        panic!("keytool's JKS unread")
    };
    assert_eq!(before.len(), 2);
    // This host's own Debian keystore, when it has one, reads as well.
    if let Ok(system) = fs::read("/etc/ssl/certs/java/cacerts") {
        match kind(&system) {
            Kind::Jks(entries) => {
                assert!(entries.len() > 50, "{}", entries.len());
                eprintln!(
                    "this host's /etc/ssl/certs/java/cacerts: JKS, {} trusted entries",
                    entries.len()
                );
            }
            other => eprintln!("this host's /etc/ssl/certs/java/cacerts: {other:?}"),
        }
    }

    let ca = certificate("cube runner CA test");
    let outcome = reconcile(&root.file(), &ca, &mut keytool_in(root.path())).unwrap();
    assert_eq!(outcome.word(), "repaired", "{outcome:?}");
    let after = fs::read(root.keystore()).unwrap();
    let Kind::Jks(entries) = kind(&after) else {
        panic!()
    };
    assert_eq!(entries.len(), 3);
    assert!(entries.contains(&(ALIAS.to_string(), der_of(ca.as_bytes()))));
    assert!(
        before.iter().all(|entry| entries.contains(entry)),
        "the roots kept"
    );
    let listed = run(
        &FREE,
        "exec keytool -list -keystore \"$1\" -storetype JKS -storepass changeit",
        std::slice::from_ref(&store),
        b"",
        Duration::from_secs(60),
    )
    .unwrap();
    assert!(
        listed.output.contains("Your keystore contains 3 entries"),
        "the JDK reads the result: {}",
        listed.output
    );
    assert_eq!(
        fs::metadata(root.keystore()).unwrap().permissions().mode() & 0o7777,
        0o644
    );

    assert_eq!(
        reconcile(&root.file(), &ca, &mut keytool_in(root.path())).unwrap(),
        Outcome::Ok
    );
    assert_eq!(
        fs::read(root.keystore()).unwrap(),
        after,
        "nothing written twice"
    );

    // The runner's CA rotated: the old one under cube's alias goes.
    let rotated = certificate("cube runner CA rotated");
    let outcome = reconcile(&root.file(), &rotated, &mut keytool_in(root.path())).unwrap();
    assert_eq!(outcome.word(), "repaired");
    let Kind::Jks(entries) = kind(&fs::read(root.keystore()).unwrap()) else {
        panic!()
    };
    assert_eq!(entries.len(), 3);
    assert!(entries.contains(&(ALIAS.to_string(), der_of(rotated.as_bytes()))));
    assert!(!entries.iter().any(|(_, der)| *der == der_of(ca.as_bytes())));
}
