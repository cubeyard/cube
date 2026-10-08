//! The QEMU and firmware paths an installation records are the operator's
//! (absolute, symlinks kept), so a package manager's launcher that points into
//! a versioned directory survives the package's upgrade.
use std::{os::unix::fs::symlink, path::Path};

use cube_node_transport::runner::{Binding, InitOptions, Runner, VmLimits};
use iroh::SecretKey;

fn qcow2(virtual_size: u64) -> Vec<u8> {
    let mut bytes = vec![0u8; 4096];
    bytes[..4].copy_from_slice(b"QFI\xfb");
    bytes[4..8].copy_from_slice(&3u32.to_be_bytes());
    bytes[24..32].copy_from_slice(&virtual_size.to_be_bytes());
    bytes
}

#[test]
fn init_records_the_given_paths_not_their_targets() {
    let root = tempfile::tempdir().unwrap();
    let support = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/support");
    let cellar = root.path().join("Cellar/qemu/10.0.0");
    std::fs::create_dir_all(cellar.join("bin")).unwrap();
    std::fs::create_dir_all(cellar.join("share/qemu")).unwrap();
    std::fs::copy(
        support.join("fake-qemu.py"),
        cellar.join("bin/qemu-system-fake"),
    )
    .unwrap();
    std::fs::copy(
        support.join("fake-qemu-img.sh"),
        cellar.join("bin/qemu-img"),
    )
    .unwrap();
    std::fs::write(cellar.join("share/qemu/firmware.fd"), b"fake firmware").unwrap();
    // The stable launcher paths, as Homebrew lays them out.
    let bin = root.path().join("bin");
    let share = root.path().join("share/qemu");
    std::fs::create_dir_all(&bin).unwrap();
    std::fs::create_dir_all(&share).unwrap();
    let qemu_link = bin.join("qemu-system-fake");
    let firmware_link = share.join("firmware.fd");
    symlink(cellar.join("bin/qemu-system-fake"), &qemu_link).unwrap();
    symlink(cellar.join("bin/qemu-img"), bin.join("qemu-img")).unwrap();
    symlink(cellar.join("share/qemu/firmware.fd"), &firmware_link).unwrap();
    let image = root.path().join("base.qcow2");
    std::fs::write(&image, qcow2(3 << 30)).unwrap();

    let installation = Runner::initialize(
        &root.path().join("state"),
        Binding {
            thread_id: "t-paths".into(),
            environment_id: 1,
            node_id: "node-paths".into(),
        },
        SecretKey::generate().public(),
        SecretKey::generate().public(),
        &image,
        InitOptions {
            qemu: Some(qemu_link.clone()),
            firmware: Some(firmware_link.clone()),
            limits: VmLimits::default(),
        },
    )
    .unwrap();
    assert_eq!(installation.qemu, qemu_link);
    assert_eq!(installation.qemu_img, bin.join("qemu-img"));
    assert_eq!(
        installation.firmware.as_deref(),
        Some(firmware_link.as_path())
    );

    // A missing firmware file is still refused at init.
    let error = Runner::initialize(
        &root.path().join("state2"),
        Binding {
            thread_id: "t-paths".into(),
            environment_id: 1,
            node_id: "node-paths".into(),
        },
        SecretKey::generate().public(),
        SecretKey::generate().public(),
        &image,
        InitOptions {
            qemu: Some(qemu_link),
            firmware: Some(share.join("missing.fd")),
            limits: VmLimits::default(),
        },
    )
    .unwrap_err();
    assert!(error.to_string().contains("firmware"), "{error:#}");
}
