//! Controls for the test support's `owner.lock` handling (F-CI-2): a held
//! lock is reported with its holder and fails after the bound, a transient
//! holder is waited out and reported, and `close` after a forced shutdown
//! leaves the lock free at once.
mod support;

use std::time::{Duration, Instant};

use cube_node_transport::runner::{Runner, VmState};
use support::*;

#[tokio::test]
async fn a_held_lock_is_dumped_and_fails_after_the_bound() {
    let fx = fixture();
    let held = Runner::open(&fx.state, fx.key.public()).unwrap();
    let started = Instant::now();
    let error = match try_open_runner(&fx, OPEN_RETRY).await {
        Ok(_) => panic!("opened a state whose lock is held"),
        Err(error) => error,
    };
    assert!(started.elapsed() >= OPEN_RETRY, "{:?}", started.elapsed());
    assert!(error.contains("owner.lock still held after"), "{error}");
    assert!(
        error.contains("another daemon owns this journal"),
        "{error}"
    );
    assert!(
        error.contains(&format!("test pid {}", std::process::id())),
        "{error}"
    );
    assert!(error.contains("--- holders at the deadline ---"), "{error}");
    if cfg!(target_os = "linux") {
        // The holder is this process: its flock in /proc/locks and its own
        // descriptor, whose fdinfo carries the lock.
        let pid = std::process::id().to_string();
        assert!(
            error.lines().any(|line| line.contains(" FLOCK ")
                && line.split_whitespace().any(|field| field == pid)),
            "{error}"
        );
        assert!(
            error.lines().any(
                |line| line.trim_start().starts_with(&format!("pid {pid} fd "))
                    && line.contains("(test)")
                    && line.contains("lock:")
            ),
            "{error}"
        );
    }
    drop(held);
    let started = Instant::now();
    let (_runner, contention) = try_open_runner(&fx, OPEN_RETRY).await.unwrap();
    assert!(contention.is_none());
    assert!(started.elapsed() < Duration::from_secs(1));
}

#[tokio::test]
async fn a_transient_holder_is_waited_out_and_reported() {
    let fx = fixture();
    let held = Runner::open(&fx.state, fx.key.public()).unwrap();
    let holder = tokio::spawn(async move {
        tokio::time::sleep(Duration::from_millis(200)).await;
        drop(held);
    });
    let (_runner, contention) = try_open_runner(&fx, OPEN_RETRY).await.unwrap();
    let contention = contention.expect("the open met the held lock");
    // The dump's own time (lsof on macOS) is not part of the hold, but a
    // dump that takes seconds still fails here.
    assert!(
        contention.held >= Duration::from_millis(150)
            && contention.held < OPEN_RETRY - Duration::from_secs(1),
        "{:?}",
        contention.held
    );
    assert!(
        contention.held + contention.diagnostics < OPEN_RETRY,
        "{:?} + {:?}",
        contention.held,
        contention.diagnostics
    );
    assert!(
        contention
            .holders
            .contains(&format!("test pid {}", std::process::id())),
        "{}",
        contention.holders
    );
    holder.await.unwrap();
}

#[tokio::test]
async fn close_after_a_forced_shutdown_frees_the_lock_at_once() {
    // The shape of the first occurrence: a started VM, shutdown(false),
    // close, and a second open of the same state.
    let fx = fixture();
    let served = serve(&fx).await;
    served.vm(allocate("t1", VM, 1, 8)).await;
    served.vm(start("t1", VM, 1, &fx.gateway, TOKEN)).await;
    served.runner.shutdown(false).await;
    assert_eq!(served.vm(inspect("t1", VM)).await.state, VmState::Stopped);
    let waited = served.close_timed().await;
    assert!(waited < Duration::from_secs(2), "{waited:?}");
    let (_runner, contention) = try_open_runner(&fx, OPEN_RETRY).await.unwrap();
    assert!(
        contention.is_none(),
        "{}",
        contention.map(|c| c.holders).unwrap_or_default()
    );
}
