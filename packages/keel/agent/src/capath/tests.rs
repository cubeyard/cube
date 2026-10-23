use std::{os::unix::fs::symlink, path::Path, process::Command};

use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, DnValue, IsCa, Issuer, KeyPair,
    PKCS_ECDSA_P256_SHA256,
};

use super::*;

fn ca(dn: DistinguishedName) -> (rcgen::Certificate, KeyPair, CertificateParams) {
    let key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let mut params = CertificateParams::default();
    params.distinguished_name = dn;
    params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
    (params.self_signed(&key).unwrap(), key, params)
}

/// `openssl` from PATH, when this host has it (CI requires it with
/// CUBE_TEST_OPENSSL=required): the reference for the hash and CApath.
fn openssl(args: &[&str], input: Option<&Path>) -> Option<String> {
    let mut command = Command::new("openssl");
    command.args(args);
    if let Some(input) = input {
        command.arg("-in").arg(input);
    }
    match command.output() {
        Ok(out) => Some(
            String::from_utf8_lossy(&out.stdout).into_owned()
                + &String::from_utf8_lossy(&out.stderr),
        ),
        Err(_) => {
            assert!(
                std::env::var("CUBE_TEST_OPENSSL").as_deref() != Ok("required"),
                "CUBE_TEST_OPENSSL=required and no openssl on PATH"
            );
            eprintln!("SKIP: no openssl on PATH");
            None
        }
    }
}

fn der(pem: &str) -> Vec<u8> {
    crate::generated::pem_certificates(pem.as_bytes()).remove(0)
}

#[test]
fn the_hash_is_openssl_s_for_every_string_kind_spacing_and_case() {
    let dir = tempfile::tempdir().unwrap();
    let mut subjects: Vec<DistinguishedName> = vec![];
    // berth's runner CA (ca.rs): O=cube, CN=cube runner CA <hex>.
    let mut berth = DistinguishedName::new();
    berth.push(DnType::OrganizationName, "cube");
    berth.push(DnType::CommonName, "cube runner CA 3f6bd2d3a5e0");
    subjects.push(berth);
    for value in [
        DnValue::PrintableString("  Cube   Runner CA ".try_into().unwrap()),
        DnValue::Utf8String("\tCUBE\n\nRunner  Ünïcode ".into()),
        DnValue::Ia5String("Mixed Case\t\tTabs".try_into().unwrap()),
        DnValue::TeletexString("T61 Latin".try_into().unwrap()),
        DnValue::BmpString("BMP Ström".try_into().unwrap()),
        DnValue::UniversalString("Universal X".try_into().unwrap()),
        DnValue::Utf8String("   ".into()),
    ] {
        let mut dn = DistinguishedName::new();
        dn.push(
            DnType::CountryName,
            DnValue::PrintableString("NO".try_into().unwrap()),
        );
        dn.push(DnType::CommonName, value);
        subjects.push(dn);
    }
    let mut checked = 0;
    for (i, dn) in subjects.into_iter().enumerate() {
        let (cert, _, _) = ca(dn);
        let path = dir.path().join(format!("{i}.pem"));
        fs::write(&path, cert.pem()).unwrap();
        let ours = subject_hash(cert.der()).unwrap();
        assert_eq!(ours.len(), 8);
        let Some(theirs) = openssl(&["x509", "-noout", "-hash"], Some(&path)) else {
            return;
        };
        assert_eq!(ours, theirs.trim(), "certificate {i}");
        checked += 1;
    }
    // A multi-valued RDN (`CN=b+O=a`, its SET sorted by DER) from openssl itself.
    let key = dir.path().join("k.pem");
    let multi = dir.path().join("multi.pem");
    let made = Command::new("openssl")
        .args([
            "req",
            "-x509",
            "-newkey",
            "ec",
            "-pkeyopt",
            "ec_paramgen_curve:P-256",
            "-nodes",
            "-days",
            "1",
            "-multivalue-rdn",
        ])
        .args([
            "-subj",
            "/C=NO/CN=Zeta  Runner+O=Alpha Org/OU=  Spaced   Unit ",
        ])
        .arg("-keyout")
        .arg(&key)
        .arg("-out")
        .arg(&multi)
        .output()
        .unwrap();
    assert!(
        made.status.success(),
        "{}",
        String::from_utf8_lossy(&made.stderr)
    );
    let pem = fs::read_to_string(&multi).unwrap();
    let theirs = openssl(&["x509", "-noout", "-hash"], Some(&multi)).unwrap();
    assert_eq!(
        subject_hash(&der(&pem)).unwrap(),
        theirs.trim(),
        "multi-valued RDN"
    );
    // This machine's runner CA, in a cube thread machine.
    if let Ok(runner) = fs::read_to_string("/etc/cube/ca.pem") {
        let theirs = openssl(
            &["x509", "-noout", "-hash"],
            Some(Path::new("/etc/cube/ca.pem")),
        )
        .unwrap();
        assert_eq!(
            subject_hash(&der(&runner)).unwrap(),
            theirs.trim(),
            "/etc/cube/ca.pem"
        );
    }
    assert_eq!(checked, 8);
    assert_eq!(subject_hash(b"not DER"), None);
}

fn readlink(path: &Path) -> Option<String> {
    fs::read_link(path)
        .ok()
        .map(|t| t.to_string_lossy().into_owned())
}

#[test]
fn one_hash_link_of_cube_s_and_nobody_else_s_touched() {
    let dir = tempfile::tempdir().unwrap();
    let certs = dir.path();
    let open = || -> OwnedFd { fs::File::open(certs).unwrap().into() };
    // Another certificate already has hash cafe0001.0; one of cube's from
    // before a rotation is beef0002.0.
    symlink("other.pem", certs.join("cafe0001.0")).unwrap();
    symlink(TARGET, certs.join("beef0002.0")).unwrap();
    symlink(TARGET, certs.join("not-a-hash.0")).unwrap();
    put_hash_link(&open(), Some("cafe0001")).unwrap();
    assert_eq!(
        readlink(&certs.join("cafe0001.0")).as_deref(),
        Some("other.pem"),
        "another's link kept"
    );
    assert_eq!(
        readlink(&certs.join("cafe0001.1")).as_deref(),
        Some(TARGET),
        "cube's the next free number"
    );
    assert!(
        readlink(&certs.join("beef0002.0")).is_none(),
        "the rotated CA's link went"
    );
    assert_eq!(
        readlink(&certs.join("not-a-hash.0")).as_deref(),
        Some(TARGET),
        "no hash name: not cube's to remove"
    );
    let entries = || {
        let mut names: Vec<String> = fs::read_dir(certs)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    };
    let before = entries();
    put_hash_link(&open(), Some("cafe0001")).unwrap();
    assert_eq!(entries(), before, "again: nothing changes");
    // A second link of cube's under the hash (openssl rehash made .0 too) goes.
    symlink(TARGET, certs.join("cafe0001.2")).unwrap();
    put_hash_link(&open(), Some("cafe0001")).unwrap();
    assert_eq!(entries(), before);
    put_hash_link(&open(), None).unwrap();
    assert!(readlink(&certs.join("cafe0001.1")).is_none());
    assert_eq!(
        readlink(&certs.join("cafe0001.0")).as_deref(),
        Some("other.pem")
    );
}

/// The link makes `-CApath` alone verify a leaf the runner's CA signed,
/// as the runner's HTTPS leaves are signed (openssl as the client).
#[test]
fn capath_alone_verifies_a_leaf_of_the_ca_through_the_link() {
    let dir = tempfile::tempdir().unwrap();
    let certs = dir.path().join("certs");
    fs::create_dir(&certs).unwrap();
    let mut dn = DistinguishedName::new();
    dn.push(DnType::OrganizationName, "cube");
    dn.push(DnType::CommonName, "cube runner CA 0123456789ab");
    let (root, key, params) = ca(dn);
    // cube-runner.pem as the CA itself (in a machine it links to cube-runner.crt).
    fs::write(certs.join(TARGET), root.pem()).unwrap();
    let mut leaf = CertificateParams::new(vec!["example.com".to_string()]).unwrap();
    leaf.distinguished_name
        .push(DnType::CommonName, "example.com");
    let leaf_key = KeyPair::generate_for(&PKCS_ECDSA_P256_SHA256).unwrap();
    let issuer = Issuer::from_params(&params, &key);
    let leaf = leaf.signed_by(&leaf_key, &issuer).unwrap();
    let leaf_path = dir.path().join("leaf.pem");
    fs::write(&leaf_path, leaf.pem()).unwrap();
    let certs_arg = certs.to_string_lossy().into_owned();
    let leaf_arg = leaf_path.to_string_lossy().into_owned();
    let verify = || {
        openssl(
            &[
                "verify",
                "-no-CAfile",
                "-no-CAstore",
                "-CApath",
                &certs_arg,
                &leaf_arg,
            ],
            None,
        )
    };
    let Some(without) = verify() else { return };
    assert!(!without.contains(": OK"), "no link, no trust: {without}");
    let fd: OwnedFd = fs::File::open(&certs).unwrap().into();
    put_hash_link(&fd, Some(&subject_hash(root.der()).unwrap())).unwrap();
    let with = verify().unwrap();
    assert!(with.contains(&format!("{leaf_arg}: OK")), "{with}");
}
