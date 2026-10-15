//! Spike 4a: simple timing loops with real percentiles (hdrhistogram, ns).
//! Usage: percentiles [ITERATIONS=100000]
use biscuit_auth::AuthorizerBuilder;
use biscuit_bench::*;
use hdrhistogram::Histogram;
use std::time::Instant;

/// `f` returns false when an authorization that should succeed failed (in
/// practice: biscuit's default 1 ms RunLimit timeout firing under load).
fn measure(name: &str, n: usize, mut f: impl FnMut() -> bool) {
    for _ in 0..n / 10 {
        f(); // warm-up
    }
    let mut failures = 0u64;
    let mut h = Histogram::<u64>::new_with_bounds(1, 10_000_000_000, 3).unwrap();
    for _ in 0..n {
        let t = Instant::now();
        if !f() {
            failures += 1;
        }
        h.record(t.elapsed().as_nanos() as u64).unwrap();
    }
    let us = |q: f64| h.value_at_quantile(q) as f64 / 1000.0;
    println!(
        "{name:<40} n={n:<7} p50={:>9.1}us p90={:>9.1}us p99={:>9.1}us p99.9={:>9.1}us max={:>9.1}us mean={:>9.1}us failures={failures}",
        us(0.5), us(0.9), us(0.99), us(0.999), h.max() as f64 / 1000.0, h.mean() / 1000.0
    );
}

fn main() {
    let n: usize = std::env::args().nth(1).map(|a| a.parse().unwrap()).unwrap_or(100_000);
    let s = setup();
    let keys = s.fixture.test_only_keys.clone();
    let policies = s.fixture.authorizer.clone();
    let base = AuthorizerBuilder::new().code(&policies).unwrap();
    println!("token: {} bytes, {} blocks", s.bytes.len(), s.token.block_count());

    measure("1_verify_token", n, || verify(&s.bytes, &keys).is_ok());
    for (name, r, new, allow) in [
        ("push_prefix", "refs/heads/cube/t1/feature", SHA_A, true),
        ("push_main_approved", "refs/heads/main", SHA_A, true),
        ("push_main_denied", "refs/heads/main", SHA_B, false),
    ] {
        let amb = s.ambient_text(&push_text(r, new));
        measure(&format!("2_uncached_{name}"), n, || {
            classify(authorize_action(&s.token, &policies, &amb), allow)
        });
        measure(&format!("3_cached_{name}"), n, || {
            classify(authorize_cached(&base, &s.token, ambient_facts(&s.ambient(), &push_action(r, new))), allow)
        });
    }
    let amb = s.ambient_text(&push_text("refs/heads/cube/t1/feature", SHA_A));
    measure("2b_verify_plus_uncached_push_prefix", n, || {
        let t = verify(&s.bytes, &keys).unwrap();
        authorize_action(&t, &policies, &amb).is_ok()
    });
    let http = s.ambient_text(r#"req_http("registry.npmjs.org", "GET", "/left-pad");"#);
    measure("2_uncached_http_get", n, || {
        authorize_action(&s.token, &policies, &http).is_ok()
    });

    let refs: Vec<String> = (0..50).map(|i| format!("refs/heads/cube/t1/r{i}")).collect();
    let texts: Vec<String> = refs.iter().map(|r| s.ambient_text(&push_text(r, SHA_A))).collect();
    let m = (n / 50).max(1000);
    measure("4_push50_uncached (whole push)", m, || {
        texts.iter().map(|t| authorize_action(&s.token, &policies, t).is_ok()).fold(true, |a, b| a & b)
    });
    measure("4_push50_cached (whole push)", m, || {
        refs.iter()
            .map(|r| authorize_cached(&base, &s.token, ambient_facts(&s.ambient(), &push_action(r, SHA_A))).is_ok())
            .fold(true, |a, b| a & b)
    });
    measure("4_push50_verify+uncached (new flow)", m, || {
        let t = verify(&s.bytes, &keys).unwrap();
        texts.iter().map(|a| authorize_action(&t, &policies, a).is_ok()).fold(true, |a, b| a & b)
    });
}

/// true when the verdict is the expected one; a deny that should have been an
/// allow (e.g. RunLimit timeout) counts as a failure.
fn classify(r: Result<usize, biscuit_auth::error::Token>, allow: bool) -> bool {
    match r {
        Ok(_) => allow,
        Err(biscuit_auth::error::Token::RunLimit(_)) => false,
        Err(_) => !allow,
    }
}
