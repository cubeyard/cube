//! Spike 4a: criterion benchmark of per-action authorization in the gate.
use biscuit_auth::AuthorizerBuilder;
use biscuit_bench::*;
use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;

fn gate(c: &mut Criterion) {
    let s = setup();
    let keys = s.fixture.test_only_keys.clone();
    let policies = s.fixture.authorizer.clone();
    let base = AuthorizerBuilder::new().code(&policies).unwrap();

    c.bench_function("1_verify_token", |b| b.iter(|| verify(black_box(&s.bytes), &keys).unwrap()));

    let cases = [
        ("push_prefix", push_text("refs/heads/cube/t1/feature", SHA_A), "refs/heads/cube/t1/feature", SHA_A, true),
        ("push_main_approved", push_text("refs/heads/main", SHA_A), "refs/heads/main", SHA_A, true),
        ("push_main_denied", push_text("refs/heads/main", SHA_B), "refs/heads/main", SHA_B, false),
    ];
    for (name, text, r, new, allow) in &cases {
        let amb = s.ambient_text(text);
        c.bench_function(&format!("2_uncached_{name}"), |b| {
            b.iter(|| {
                let res = authorize_action(&s.token, &policies, black_box(&amb));
                let _ = (black_box(res), allow); // verdicts are checked by the fixtures; RunLimit timeouts under load are counted by `percentiles`
            })
        });
        c.bench_function(&format!("3_cached_{name}"), |b| {
            b.iter(|| {
                let res = authorize_cached(&base, &s.token, ambient_facts(&s.ambient(), &push_action(r, new)));
                let _ = (black_box(res), allow); // verdicts are checked by the fixtures; RunLimit timeouts under load are counted by `percentiles`
            })
        });
    }
    c.bench_function("2b_verify_plus_uncached_push_prefix", |b| {
        let amb = s.ambient_text(&push_text("refs/heads/cube/t1/feature", SHA_A));
        b.iter(|| {
            let t = verify(&s.bytes, &keys).unwrap();
            let _ = black_box(authorize_action(&t, &policies, &amb));
        })
    });

    let refs: Vec<String> = (0..50).map(|i| format!("refs/heads/cube/t1/r{i}")).collect();
    let texts: Vec<String> = refs.iter().map(|r| s.ambient_text(&push_text(r, SHA_A))).collect();
    c.bench_function("4_push50_uncached", |b| {
        b.iter(|| {
            for t in &texts {
                let _ = black_box(authorize_action(&s.token, &policies, t));
            }
        })
    });
    c.bench_function("4_push50_cached", |b| {
        b.iter(|| {
            for r in &refs {
                let _ = black_box(authorize_cached(&base, &s.token, ambient_facts(&s.ambient(), &push_action(r, SHA_A))));
            }
        })
    });
}

criterion_group!(benches, gate);
criterion_main!(benches);
