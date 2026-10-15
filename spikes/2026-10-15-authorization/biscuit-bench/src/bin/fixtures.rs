//! Fixture runner (spike 4b). Usage:
//!   fixtures [DIR]                       mint each fixture in Rust, evaluate, compare with expect
//!   fixtures [DIR] --mint-to OUT         also write OUT/<name>.b64 (Rust-minted tokens)
//!   fixtures [DIR] --verify-from IN      evaluate IN/<name>.b64 (tokens minted elsewhere, e.g. TS)
//! Prints one line per fixture: name, verdict, expect, reason. Exit 1 on any mismatch.
use biscuit_bench::*;
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let default = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../packages/runner-protocol/fixtures/authz/datalog");
    let dir = args.get(1).filter(|a| !a.starts_with("--")).cloned().unwrap_or(default.into());
    let flag = |n: &str| args.iter().position(|a| a == n).map(|i| PathBuf::from(&args[i + 1]));
    let mint_to = flag("--mint-to");
    let verify_from = flag("--verify-from");
    if let Some(d) = &mint_to {
        std::fs::create_dir_all(d).unwrap();
    }
    let fixtures = load_fixtures(&PathBuf::from(dir));
    let mut bad = 0;
    for f in &fixtures {
        let bytes = match &verify_from {
            Some(d) => {
                let b64 = std::fs::read_to_string(d.join(format!("{}.b64", f.name))).unwrap();
                base64_url_decode(b64.trim())
            }
            None => {
                let t = mint(f).unwrap_or_else(|e| panic!("{}: mint: {e}", f.name));
                assert_eq!(t.root_key_id(), Some(f.test_only_keys.root_key_id), "root key id read back");
                t.to_vec().unwrap()
            }
        };
        if let Some(d) = &mint_to {
            let t = biscuit_auth::UnverifiedBiscuit::from(&bytes).unwrap();
            std::fs::write(d.join(format!("{}.b64", f.name)), t.to_base64().unwrap()).unwrap();
        }
        let (verdict, reason) = evaluate(&bytes, f);
        let ok = verdict == f.expect;
        if !ok {
            bad += 1;
        }
        println!("{}\t{}\t{}\t{}\t{}", if ok { "ok" } else { "MISMATCH" }, f.name, verdict, f.expect, reason.replace('\n', " "));
    }
    println!("rust: {} fixtures, {} mismatches", fixtures.len(), bad);
    std::process::exit(if bad == 0 { 0 } else { 1 });
}

fn base64_url_decode(s: &str) -> Vec<u8> {
    // biscuit uses URL-safe base64; UnverifiedBiscuit::from_base64 handles it.
    biscuit_auth::UnverifiedBiscuit::from_base64(s).unwrap().to_vec().unwrap()
}
