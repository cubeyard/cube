use super::*;

/// A `.deb` of `control` and `data` (name, mode, contents; a directory ends
/// in `/`, a symlink is `-> target`), xz-compressed as Debian's are.
fn deb(control: &[(&str, u32, &str)], data: &[(&str, u32, &str)]) -> Vec<u8> {
    fn tar_of(entries: &[(&str, u32, &str)]) -> Vec<u8> {
        let mut builder = tar::Builder::new(Vec::new());
        for (path, mode, contents) in entries {
            let mut header = tar::Header::new_gnu();
            header.set_mode(*mode);
            header.set_mtime(1_700_000_000);
            header.set_uid(0);
            header.set_gid(0);
            if path.ends_with('/') {
                header.set_entry_type(tar::EntryType::Directory);
                header.set_size(0);
                builder.append_data(&mut header, path, io::empty()).unwrap();
            } else if let Some(target) = contents.strip_prefix("-> ") {
                header.set_entry_type(tar::EntryType::Symlink);
                header.set_size(0);
                builder.append_link(&mut header, path, target).unwrap();
            } else {
                header.set_entry_type(tar::EntryType::Regular);
                header.set_size(contents.len() as u64);
                builder
                    .append_data(&mut header, path, contents.as_bytes())
                    .unwrap();
            }
        }
        builder.into_inner().unwrap()
    }
    fn xz(bytes: &[u8]) -> Vec<u8> {
        let mut out = Vec::new();
        lzma_rs::xz_compress(&mut io::BufReader::new(bytes), &mut out).unwrap();
        out
    }
    let mut ar = b"!<arch>\n".to_vec();
    for (name, body) in [
        ("debian-binary", b"2.0\n".to_vec()),
        ("control.tar.xz", xz(&tar_of(control))),
        ("data.tar.xz", xz(&tar_of(data))),
    ] {
        ar.extend_from_slice(
            format!(
                "{name:<16}{:<12}{:<6}{:<6}{:<8}{:<10}`\n",
                0,
                0,
                0,
                100644,
                body.len()
            )
            .as_bytes(),
        );
        ar.extend_from_slice(&body);
        if body.len() % 2 == 1 {
            ar.push(b'\n');
        }
    }
    ar
}

fn package(name: &str, version: &str) -> Package {
    Package {
        name: name.into(),
        version: version.into(),
        architecture: "amd64".into(),
        archive: "debian".into(),
        filename: format!("pool/main/x/{name}/{name}_{version}_amd64.deb"),
        size: 0,
        sha256: String::new(),
    }
}

/// Every entry of a tar: path → (type, mode, contents or link target).
fn entries(tar_bytes: &[u8]) -> BTreeMap<String, (tar::EntryType, u32, String)> {
    let mut archive = tar::Archive::new(tar_bytes);
    let mut out = BTreeMap::new();
    for entry in archive.entries().unwrap() {
        let mut entry = entry.unwrap();
        let path = entry
            .path()
            .unwrap()
            .to_str()
            .unwrap()
            .trim_end_matches('/')
            .to_owned();
        let kind = entry.header().entry_type();
        let mode = entry.header().mode().unwrap();
        let mut text = String::new();
        if kind == tar::EntryType::Symlink {
            text = entry
                .link_name()
                .unwrap()
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned();
        } else {
            entry.read_to_string(&mut text).unwrap();
        }
        assert!(
            out.insert(path.clone(), (kind, mode, text)).is_none(),
            "{path} twice"
        );
    }
    out
}

const BASE_GROUP: &str = "root:x:0:\nshadow:x:42:\nusers:x:100:\n";
const BASE_GSHADOW: &str = "root:*::\nshadow:*::\nusers:*::\n";

/// The image's files, with `status` leaked for the test (it is small).
fn base(status: &str) -> Base {
    Base {
        status: Box::leak(status.to_owned().into_boxed_str()),
        group: BASE_GROUP,
        gshadow: BASE_GSHADOW,
    }
}

const BASE_STATUS: &str = "Package: apt\nStatus: install ok installed\nVersion: 3.0\nDescription: a\n more\n\nPackage: zlib1g\nStatus: install ok installed\nMulti-Arch: same\nArchitecture: amd64\nVersion: 1\n\n";

fn two_packages(dir: &Path) -> Vec<(Package, PathBuf)> {
    let sudo = deb(
        &[
            ("./", 0o755, ""),
            (
                "./control",
                0o644,
                "Package: sudo\nVersion: 1.9\nArchitecture: amd64\nMaintainer: m\nHomepage: https://www.sudo.ws/\nDescription: s\n more text\n .\n end\nSection: admin\nPriority: optional\n",
            ),
            ("./conffiles", 0o644, "/etc/sudoers\n"),
            ("./postinst", 0o755, "#!/bin/sh\n"),
            ("./triggers", 0o644, "activate-noawait ldconfig\n"),
        ],
        &[
            ("./", 0o755, ""),
            ("./etc/", 0o755, ""),
            ("./etc/sudoers", 0o644, "root ALL=(ALL) ALL\n"),
            ("./usr/", 0o755, ""),
            ("./usr/bin/", 0o755, ""),
            ("./usr/bin/sudo", 0o4755, "ELF"),
        ],
    );
    let ca = deb(
        &[
            (
                "./control",
                0o644,
                "Package: ca-certificates\nVersion: 2025\nArchitecture: all\nMulti-Arch: foreign\nDescription: c\n",
            ),
            (
                "./triggers",
                0o644,
                "interest update-ca-certificates\ninterest-noawait update-ca-certificates-fresh\n",
            ),
        ],
        &[
            ("./", 0o755, ""),
            ("./usr/", 0o755, ""),
            ("./usr/share/", 0o755, ""),
            ("./usr/share/ca-certificates/", 0o755, ""),
            ("./usr/share/ca-certificates/mozilla/", 0o755, ""),
            (
                "./usr/share/ca-certificates/mozilla/B Root (2), x.crt",
                0o644,
                "-----B-----\n",
            ),
            (
                "./usr/share/ca-certificates/mozilla/A_Root.crt",
                0o644,
                "-----A-----",
            ),
        ],
    );
    let mut out = Vec::new();
    for (p, bytes) in [
        (package("ca-certificates", "2025"), ca),
        (package("sudo", "1.9"), sudo),
    ] {
        let path = dir.join(format!("{}.deb", p.name));
        fs::write(&path, bytes).unwrap();
        out.push((p, path));
    }
    out
}

#[test]
fn the_layer_has_the_packages_and_what_their_scripts_would_write() {
    let dir = tempfile::tempdir().unwrap();
    let debs = two_packages(dir.path());
    let tar_bytes = build_layer(&base(BASE_STATUS), &debs, Vec::new()).unwrap();
    let all = entries(&tar_bytes);

    // Files as packaged; sudo setuid; /etc/sudoers 0440 as sudo's postinst.
    assert_eq!(all["usr/bin/sudo"].1, 0o4755);
    assert_eq!(all["etc/sudoers"].1, 0o440);
    assert_eq!(all["etc/sudoers"].2, "root ALL=(ALL) ALL\n");
    // Each directory once (both packages have usr/), no root entry.
    assert!(all.contains_key("usr"));
    assert!(!all.contains_key("") && !all.contains_key("."));

    // update-ca-certificates: sorted, each enabled, links, one bundle with
    // every certificate ending in a newline.
    let conf = &all["etc/ca-certificates.conf"].2;
    assert!(conf.starts_with(CA_CONF_HEADER));
    assert_eq!(
        &conf[CA_CONF_HEADER.len()..],
        "mozilla/A_Root.crt\nmozilla/B Root (2), x.crt\n"
    );
    assert_eq!(
        all["etc/ssl/certs/ca-certificates.crt"].2,
        "-----A-----\n-----B-----\n"
    );
    assert_eq!(
        all["etc/ssl/certs/B_Root_=2=__x.pem"],
        (
            tar::EntryType::Symlink,
            0o777,
            "/usr/share/ca-certificates/mozilla/B Root (2), x.crt".into()
        )
    );
    assert_eq!(
        all["usr/local/share/ca-certificates"].0,
        tar::EntryType::Directory
    );

    // dpkg: the image's packages kept, the new ones installed in dpkg's
    // order with their conffiles' md5, sorted by name.
    let status = &all["var/lib/dpkg/status"].2;
    let names: Vec<&str> = status
        .lines()
        .filter_map(|l| l.strip_prefix("Package: "))
        .collect();
    assert_eq!(names, ["apt", "ca-certificates", "sudo", "zlib1g"]);
    assert!(status.ends_with("Version: 1\n\n"), "{status:?}");
    let sudo = status
        .split("\n\n")
        .find(|p| p.starts_with("Package: sudo"))
        .unwrap();
    assert_eq!(
        sudo,
        format!(
            "Package: sudo\nStatus: install ok installed\nPriority: optional\nSection: admin\nMaintainer: m\nArchitecture: amd64\nVersion: 1.9\nConffiles:\n /etc/sudoers {}\nDescription: s\n more text\n .\n end\nHomepage: https://www.sudo.ws/",
            hex(&Md5::digest(b"root ALL=(ALL) ALL\n"))
        )
    );
    assert_eq!(all["var/lib/dpkg/info/sudo.postinst"].1, 0o755);
    assert_eq!(all["var/lib/dpkg/info/sudo.conffiles"].2, "/etc/sudoers\n");
    assert_eq!(
        all["var/lib/dpkg/info/sudo.list"].2,
        "/.\n/etc\n/etc/sudoers\n/usr\n/usr/bin\n/usr/bin/sudo\n"
    );
    assert_eq!(
        all["var/lib/dpkg/triggers/update-ca-certificates"].2,
        "ca-certificates\n"
    );
    assert_eq!(
        all["var/lib/dpkg/triggers/update-ca-certificates-fresh"].2,
        "ca-certificates/noawait\n"
    );
    // activate lines register nothing.
    assert!(!all.contains_key("var/lib/dpkg/triggers/ldconfig"));

    // The same packages give the same bytes.
    assert_eq!(
        build_layer(&base(BASE_STATUS), &debs, Vec::new()).unwrap(),
        tar_bytes
    );
}

#[test]
fn a_package_the_image_has_or_a_file_in_two_packages_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let debs = two_packages(dir.path());
    let with_sudo = format!("{BASE_STATUS}Package: sudo\nVersion: 0\n\n");
    let error = build_layer(&base(&with_sudo), &debs, Vec::new()).unwrap_err();
    assert!(
        format!("{error:#}").contains("sudo is in the image already"),
        "{error:#}"
    );

    let twice = vec![debs[1].clone(), (package("sudo", "1.9"), debs[1].1.clone())];
    let error = build_layer(&base(BASE_STATUS), &twice, Vec::new()).unwrap_err();
    assert!(
        format!("{error:#}").contains("is in two packages"),
        "{error:#}"
    );
}

#[test]
fn a_package_whose_control_file_differs_from_the_plan_is_refused() {
    let dir = tempfile::tempdir().unwrap();
    let mut debs = two_packages(dir.path());
    debs[1].0.version = "1.8".into();
    let error = build_layer(&base(BASE_STATUS), &debs, Vec::new()).unwrap_err();
    assert!(
        format!("{error:#}").contains("another package or version"),
        "{error:#}"
    );
}

#[test]
fn paths_are_cleaned_and_dot_dot_refused() {
    assert_eq!(clean(Path::new("./usr/bin/")).unwrap(), "usr/bin");
    assert_eq!(clean(Path::new("./")).unwrap(), "");
    assert_eq!(clean(Path::new("/etc/x")).unwrap(), "etc/x");
    assert!(clean(Path::new("./usr/../etc")).is_err());
}

/// The plan berth carries: both platforms of one pinned image, every
/// package pinned, what cube needs requested, the layer's sha256 pinned.
#[test]
fn the_pinned_plan_is_whole() {
    let plan = plan();
    let reference = default_image();
    // The tag is a label; the digest (the index of both platforms) decides.
    assert_eq!(
        reference.to_string(),
        "docker.io/library/debian@sha256:4c25275446ca371766b8b093c696782eabce06263fccacb8d5d813b3dc44b308"
    );
    assert!(plan.image.starts_with("docker.io/library/debian:trixie-"));
    assert_eq!(
        plan.requested,
        [
            "sudo",
            "git",
            "gh",
            "curl",
            "ca-certificates",
            "openssh-client"
        ]
    );
    assert_eq!(
        plan.platforms.keys().collect::<Vec<_>>(),
        ["linux/amd64", "linux/arm64"]
    );
    for (platform, p) in &plan.platforms {
        p.diff_id().unwrap_or_else(|e| panic!("{platform}: {e:#}"));
        assert!(p.manifest.starts_with("sha256:") && p.manifest.len() == 71);
        assert!(p.base().unwrap().status.starts_with("Package: "));
        let names: Vec<&str> = p.packages.iter().map(|p| p.name.as_str()).collect();
        let mut sorted = names.clone();
        sorted.sort();
        sorted.dedup();
        assert_eq!(names, sorted, "{platform}: sorted by name, once each");
        for wanted in &plan.requested {
            assert!(names.contains(&wanted.as_str()), "{platform}: {wanted}");
        }
        let arch = platform.strip_prefix("linux/").unwrap();
        for package in &p.packages {
            assert!(
                package.sha256.len() == 64 && package.size > 0,
                "{}",
                package.name
            );
            assert!(["debian", "debian-security"].contains(&package.archive.as_str()));
            assert!(package.filename.starts_with("pool/"));
            assert!(package.architecture == arch || package.architecture == "all");
        }
        // No package of the plan is in the image already.
        for package in &p.packages {
            assert!(
                !p.base()
                    .unwrap()
                    .status
                    .contains(&format!("\nPackage: {}\n", package.name)),
                "{platform}: {} is in the image",
                package.name
            );
        }
    }
    assert!(
        for_manifest(
            Platform {
                os: "linux",
                architecture: "amd64"
            },
            &plan.platforms["linux/amd64"].manifest
        )
        .is_some()
    );
    assert!(
        for_manifest(
            Platform {
                os: "linux",
                architecture: "arm64"
            },
            &plan.platforms["linux/amd64"].manifest
        )
        .is_none()
    );
    assert!(
        for_manifest(
            Platform {
                os: "linux",
                architecture: "amd64"
            },
            "sha256:00"
        )
        .is_none()
    );
}

#[test]
fn packages_come_from_the_mirror_then_the_snapshot() {
    let p = &plan().platforms["linux/amd64"].packages[0];
    let urls = urls(p);
    assert_eq!(
        urls[0],
        format!("https://deb.debian.org/{}/{}", p.archive, p.filename)
    );
    assert_eq!(
        urls[1],
        format!(
            "https://snapshot.debian.org/archive/{}/{}/{}",
            p.archive,
            plan().snapshot,
            p.filename
        )
    );
}

struct Lines(std::sync::Mutex<Vec<String>>);
impl Progress for Lines {
    fn line(&self, text: &str) {
        self.0.lock().unwrap().push(text.into());
    }
}

/// A runner directory whose cache has the layer already: nothing is
/// fetched (no network in this test), nothing built.
#[tokio::test]
async fn a_cached_layer_is_used_as_it_is() {
    let dir = tempfile::tempdir().unwrap();
    let p = &plan().platforms["linux/amd64"];
    let cache = LayerCache::open(image::layer_dir(dir.path())).unwrap();
    cache
        .publish(&p.diff_id().unwrap(), |out| Ok(fs::write(out, b"erofs")?))
        .unwrap();
    let lines = Lines(Default::default());
    let prepare = Prepare {
        directory: dir.path(),
        mkfs: Path::new("/nonexistent/mkfs.erofs"),
        progress: &lines,
        cancel: Arc::new(AtomicBool::new(false)),
        time_limits: TimeLimits::default(),
        free_space: &|_| Ok(0),
    };
    assert_eq!(prepare.ensure(p).await.unwrap(), p.diff_id().unwrap());
    assert!(lines.0.lock().unwrap().is_empty());
}

/// Too little room: refused before anything is fetched.
#[tokio::test]
async fn too_little_free_space_is_refused_before_a_fetch() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir_all(dir.path().join("images")).unwrap();
    let p = &plan().platforms["linux/amd64"];
    let lines = Lines(Default::default());
    let prepare = Prepare {
        directory: dir.path(),
        mkfs: Path::new("/nonexistent/mkfs.erofs"),
        progress: &lines,
        cancel: Arc::new(AtomicBool::new(false)),
        time_limits: TimeLimits::default(),
        free_space: &|_| Ok(1 << 20),
    };
    let error = prepare.ensure(p).await.unwrap_err();
    assert!(format!("{error:#}").contains("needs"), "{error:#}");
    assert!(lines.0.lock().unwrap().is_empty());
}

/// Fetches every pinned package of both platforms from Debian and builds
/// each layer's tar, printing its sha256 (what `diffId` pins) and writing
/// it to `$BERTH_DEBIAN_OUT/<arch>.tar` when that is set. Network, about
/// 70 MB:
/// `cargo test -p berth debian::tests::build_the_pinned_layers -- --ignored --nocapture`
#[tokio::test]
#[ignore]
async fn build_the_pinned_layers() {
    let client = image::client(true).unwrap();
    for (platform, p) in &plan().platforms {
        let dir = tempfile::tempdir().unwrap();
        let mut debs = Vec::new();
        for package in &p.packages {
            let path = dir.path().join(format!("{}.deb", package.name));
            fetch(&client, package, &path, &AtomicBool::new(false))
                .await
                .unwrap();
            debs.push((package.clone(), path));
        }
        let tar = build_layer(&p.base().unwrap(), &debs, Vec::new()).unwrap();
        let diff_id = DiffId::from_bytes(Sha256::digest(&tar).into());
        println!(
            "{platform}: {diff_id} ({} tar bytes); pinned {}",
            tar.len(),
            p.diff_id
        );
        if let Some(out) = std::env::var_os("BERTH_DEBIAN_OUT") {
            let arch = platform.strip_prefix("linux/").unwrap();
            fs::write(Path::new(&out).join(format!("{arch}.tar")), &tar).unwrap();
        }
    }
}

/// openssh-client's postinst: `addgroup --system _ssh` (the first free gid
/// from 100) and ssh-agent setgid `_ssh` 2755; nothing of it without the
/// package.
#[test]
fn openssh_clients_group_is_added_as_addgroup_would() {
    let dir = tempfile::tempdir().unwrap();
    let ssh = deb(
        &[(
            "./control",
            0o644,
            "Package: openssh-client\nVersion: 1:10.0p1\nArchitecture: amd64\nMulti-Arch: foreign\nDescription: o\n",
        )],
        &[
            ("./", 0o755, ""),
            ("./usr/", 0o755, ""),
            ("./usr/bin/", 0o755, ""),
            ("./usr/bin/ssh", 0o755, "ELF"),
            ("./usr/bin/ssh-agent", 0o755, "ELF"),
        ],
    );
    let path = dir.path().join("openssh-client.deb");
    fs::write(&path, ssh).unwrap();
    let debs = vec![(package("openssh-client", "1:10.0p1"), path)];
    let tar_bytes = build_layer(&base(BASE_STATUS), &debs, Vec::new()).unwrap();
    let all = entries(&tar_bytes);
    assert_eq!(all["etc/group"].2, format!("{BASE_GROUP}_ssh:x:101:\n"));
    assert_eq!(all["etc/gshadow"].2, format!("{BASE_GSHADOW}_ssh:!::\n"));
    assert_eq!(all["etc/gshadow"].1, 0o640);
    assert_eq!(all["usr/bin/ssh-agent"].1, 0o2755);
    assert_eq!(all["usr/bin/ssh"].1, 0o755);
    let mut archive = tar::Archive::new(tar_bytes.as_slice());
    let owners: BTreeMap<String, (u64, String)> = archive
        .entries()
        .unwrap()
        .map(|e| {
            let e = e.unwrap();
            let h = e.header();
            (
                e.path().unwrap().to_str().unwrap().to_owned(),
                (h.gid().unwrap(), h.groupname().unwrap().unwrap().to_owned()),
            )
        })
        .collect();
    assert_eq!(owners["usr/bin/ssh-agent"], (101, "_ssh".to_owned()));
    assert_eq!(owners["etc/gshadow"], (42, "shadow".to_owned()));

    // An image with the group already is refused, not given a second one.
    let mut taken = base(BASE_STATUS);
    taken.group = "shadow:x:42:\n_ssh:x:120:\n";
    let error = build_layer(&taken, &debs, Vec::new()).unwrap_err();
    assert!(
        format!("{error:#}").contains("has the group _ssh already"),
        "{error:#}"
    );

    // Without openssh-client, /etc/group is the image's.
    let other = two_packages(dir.path());
    let all = entries(&build_layer(&base(BASE_STATUS), &other, Vec::new()).unwrap());
    assert!(!all.contains_key("etc/group") && !all.contains_key("etc/gshadow"));
}
