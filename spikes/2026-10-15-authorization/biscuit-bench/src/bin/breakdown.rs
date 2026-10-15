//! Spike 4a: where one authorization spends its time (means over N runs).
use biscuit_auth::AuthorizerBuilder;
use biscuit_bench::*;
use std::time::{Duration, Instant};

fn main() {
    let n: u32 = std::env::args().nth(1).map(|a| a.parse().unwrap()).unwrap_or(20_000);
    let s = setup();
    let policies = s.fixture.authorizer.clone();
    let amb = s.ambient_text(&push_text("refs/heads/cube/t1/feature", SHA_A));
    let base = AuthorizerBuilder::new().code(&policies).unwrap();
    let (mut parse, mut build, mut run) = (Duration::ZERO, Duration::ZERO, Duration::ZERO);
    for _ in 0..n {
        let t0 = Instant::now();
        let b = AuthorizerBuilder::new().code(&policies).unwrap().code(&amb).unwrap();
        let t1 = Instant::now();
        let mut a = b.build(&s.token).unwrap();
        let t2 = Instant::now();
        let _ = a.authorize();
        let t3 = Instant::now();
        parse += t1 - t0;
        build += t2 - t1;
        run += t3 - t2;
    }
    let us = |d: Duration| d.as_secs_f64() * 1e6 / n as f64;
    println!("uncached: parse policies+ambient {:.1}us, build(token) {:.1}us, authorize {:.1}us", us(parse), us(build), us(run));
    let (mut clone, mut build2) = (Duration::ZERO, Duration::ZERO);
    let mut fresh = Duration::ZERO;
    for _ in 0..n {
        let t0 = Instant::now();
        let mut b = base.clone();
        for f in ambient_facts(&s.ambient(), &push_action("refs/heads/cube/t1/feature", SHA_A)) {
            b = b.fact(f).unwrap();
        }
        let t1 = Instant::now();
        let mut a = b.build(&s.token).unwrap();
        let t2 = Instant::now();
        let _ = a.authorize();
        clone += t1 - t0;
        build2 += t2 - t1;
        fresh += t2.elapsed();
    }
    println!("cached:   clone builder+facts {:.1}us, build(token) {:.1}us, authorize {:.1}us", us(clone), us(build2), us(fresh));
}
