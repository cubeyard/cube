//! Refused egress, reported to cubed (runner.proto's `Open.report`; B-4
//! decision 1): one `report` stream per connection, opened by the runner at
//! the first report, `EgressReport` frames until FIN; cubed never answers.
//!
//! ```text
//! refusal -> queue (256 per runner), never written from the flow
//!   queue full -> dropped and counted -> the next report has dropped_before = n
//! a connection lives -> its writer sends the queue on one stream
//!   a write that does not finish in WRITE_TIMEOUT ends that stream;
//!   what is left waits for the next connection
//! ```
//!
//! Egress never waits for reporting.
use std::{
    collections::VecDeque,
    sync::{Arc, Mutex},
    time::Duration,
};

use cube_runner_protocol::{
    Timestamp,
    proto::{self, open},
    write_frame,
};
use iroh::endpoint::Connection;
use tokio::sync::Notify;

pub const QUEUE: usize = 256;
pub const WRITE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
struct Queue {
    items: VecDeque<proto::EgressReport>,
    dropped: u64,
}

#[derive(Default)]
pub struct Reports {
    queue: Mutex<Queue>,
    ready: Notify,
    /// One writer at a time, on the connection that has it.
    writer: tokio::sync::Mutex<()>,
}

impl Reports {
    pub fn new() -> Arc<Self> {
        Arc::default()
    }

    /// Queues a report of a refused attempt by machine `reference`.
    pub fn push(&self, reference: &proto::Ref, host: &str, reason: &str) {
        {
            let mut queue = self.queue.lock().unwrap();
            if queue.items.len() >= QUEUE {
                queue.dropped += 1;
                return;
            }
            let dropped_before = std::mem::take(&mut queue.dropped);
            queue.items.push_back(proto::EgressReport {
                r#ref: Some(reference.clone()),
                host: host.chars().take(256).collect(),
                reason: reason.into(),
                dropped_before,
                at: Some(Timestamp::now()),
            });
        }
        self.ready.notify_one();
    }

    #[cfg(test)]
    pub fn queued(&self) -> Vec<proto::EgressReport> {
        self.queue.lock().unwrap().items.iter().cloned().collect()
    }

    fn front(&self) -> Option<proto::EgressReport> {
        self.queue.lock().unwrap().items.front().cloned()
    }

    fn sent(&self) {
        self.queue.lock().unwrap().items.pop_front();
    }

    /// Sends the queue to cubed over `connection` for as long as it lives
    /// and cubed reads. A report leaves the queue only once written.
    pub async fn run(self: Arc<Self>, connection: Connection) {
        let _writer = self.writer.lock().await;
        let mut stream = None;
        loop {
            let Some(report) = self.front() else {
                let ready = self.ready.notified();
                tokio::pin!(ready);
                ready.as_mut().enable();
                if self.front().is_some() {
                    continue;
                }
                tokio::select! {
                    _ = ready => continue,
                    _ = connection.closed() => return,
                }
            };
            let write = async {
                if stream.is_none() {
                    let (mut send, recv) = connection.open_bi().await?;
                    write_frame(
                        &mut send,
                        &proto::Open {
                            kind: Some(open::Kind::Report(proto::ReportHeader {})),
                        },
                    )
                    .await?;
                    stream = Some((send, recv));
                }
                let (send, _) = stream.as_mut().unwrap();
                write_frame(send, &report).await
            };
            match tokio::time::timeout(WRITE_TIMEOUT, write).await {
                Ok(Ok(())) => self.sent(),
                // cubed does not read, or the connection went: the rest
                // waits for the next connection.
                _ => {
                    if let Some((mut send, _)) = stream.take() {
                        let _ = send.reset(0u32.into());
                    }
                    return;
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_full_queue_drops_and_the_next_report_counts_them() {
        let reports = Reports::new();
        let reference = proto::Ref {
            owner: "thread-1".into(),
            id: "0123456789abcdef".into(),
        };
        for i in 0..QUEUE + 5 {
            reports.push(&reference, &format!("h{i}.example"), "policy");
        }
        let queued = reports.queued();
        assert_eq!(queued.len(), QUEUE);
        assert!(queued.iter().all(|r| r.dropped_before == 0));
        reports.sent();
        reports.push(&reference, "after.example", "deny_host");
        let last = reports.queued().pop().unwrap();
        assert_eq!(
            (last.host.as_str(), last.dropped_before),
            ("after.example", 5)
        );
        reports.sent();
        reports.push(&reference, "next.example", "policy");
        assert_eq!(reports.queued().pop().unwrap().dropped_before, 0);
    }

    /// cubed's end: a loopback Iroh connection as `berth vm` serves it, the
    /// runner's report writer on it, and the stream read as cubed would.
    #[tokio::test]
    async fn reports_reach_cubed_on_one_runner_opened_stream() {
        use crate::{NetworkMode, bind};
        use cube_runner_protocol::{ALPN, read_frame};
        let runner = bind(iroh::SecretKey::generate(), NetworkMode::Loopback, None)
            .await
            .unwrap();
        let cubed = bind(iroh::SecretKey::generate(), NetworkMode::Loopback, None)
            .await
            .unwrap();
        let reports = Reports::new();
        let reference = proto::Ref {
            owner: "thread-1".into(),
            id: "0123456789abcdef".into(),
        };
        // Queued while no cubed is connected: 4 more than fit.
        for i in 0..QUEUE + 4 {
            reports.push(&reference, &format!("h{i}.example"), "policy");
        }
        let accepting = {
            let runner = runner.clone();
            tokio::spawn(async move { runner.accept().await.unwrap().await.unwrap() })
        };
        let to_runner = cubed.connect(runner.addr(), ALPN).await.unwrap();
        let connection = accepting.await.unwrap();
        // cubed's presence records the address of its direct path.
        let presence = crate::vm::presence::Presence::new();
        let attached = presence.attach(Some(connection.clone()));
        assert!(
            presence
                .cubed_addresses()
                .contains(&"127.0.0.1".parse::<std::net::IpAddr>().unwrap()),
            "{:?}",
            presence.cubed_addresses()
        );
        let writer = tokio::spawn(Arc::clone(&reports).run(connection.clone()));
        let (_, mut recv) = to_runner.accept_bi().await.unwrap();
        let open: proto::Open = read_frame(&mut recv).await.unwrap();
        assert!(matches!(open.kind, Some(open::Kind::Report(_))), "{open:?}");
        for i in 0..QUEUE {
            let report: proto::EgressReport = read_frame(&mut recv).await.unwrap();
            assert_eq!(report.host, format!("h{i}.example"));
            assert_eq!(report.r#ref.as_ref(), Some(&reference));
            assert_eq!(report.dropped_before, 0);
        }
        // Later refusals follow on the same stream; the first counts the drops.
        reports.push(&reference, "after.example", "deny_host");
        let report: proto::EgressReport = read_frame(&mut recv).await.unwrap();
        assert_eq!(
            (
                report.host.as_str(),
                report.reason.as_str(),
                report.dropped_before
            ),
            ("after.example", "deny_host", 4)
        );
        assert!(
            reports.queued().is_empty(),
            "written reports leave the queue"
        );
        // cubed goes: the presence counts it gone, the writer ends, and what
        // is refused meanwhile waits in the queue.
        to_runner.close(0u32.into(), b"bye");
        tokio::time::timeout(Duration::from_secs(10), writer)
            .await
            .expect("the writer ends with the connection")
            .unwrap();
        drop(attached);
        assert_eq!(presence.now().connections, 0);
        reports.push(&reference, "later.example", "lease_expired");
        assert_eq!(reports.queued().len(), 1);
        assert!(
            presence
                .cubed_addresses()
                .contains(&"127.0.0.1".parse::<std::net::IpAddr>().unwrap()),
            "remembered after the connection went"
        );
    }
}
