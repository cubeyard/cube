//! B-6 in process: cubed's `dial` streams over a real Iroh connection on
//! loopback, answered by serve.rs as `berth vm` answers them, into the
//! machine's LAN (cube-netstack, unchanged) and a smoltcp guest listening
//! on its port. The test plays cubed. The real chain (cubed's Portal and
//! RunnerSession, berth vm, a keel machine) is V9 in runner-vm-test.ts.
use super::*;
use crate::vm::{dial_into, dial_port};
use crate::{NetworkMode, bind, serve};
use cube_runner_protocol::{
    ALPN,
    proto::{Code, open},
    read_frame, write_frame,
};
use iroh::endpoint::{Connection, RecvStream, SendStream};
use sha2::{Digest, Sha256};

impl TestGuest {
    /// A socket listening on `port`; [`Self::accepted`] waits for its peer.
    fn listen(&self, port: u16) -> SocketHandle {
        let mut s = Self::tcp_socket();
        s.listen(port).unwrap();
        let handle = self.inner.lock().unwrap().sockets.add(s);
        self.notify.notify_one();
        handle
    }

    async fn accepted(&self, handle: SocketHandle) -> GuestTcp {
        for _ in 0..500 {
            if matches!(
                self.state(handle),
                tcp::State::Established | tcp::State::CloseWait
            ) {
                return GuestTcp {
                    guest: self.clone(),
                    handle,
                };
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!("no connection to the guest's port");
    }
}

/// cubed's connection to a runner that answers `dial` streams into `env`'s
/// machine as `berth vm` does: the port rule, then the LAN.
async fn runner(env: &Env) -> (Connection, (iroh::Endpoint, iroh::Endpoint)) {
    let runner = bind(iroh::SecretKey::generate(), NetworkMode::Loopback, None)
        .await
        .unwrap();
    let cubed = bind(iroh::SecretKey::generate(), NetworkMode::Loopback, None)
        .await
        .unwrap();
    let accepting = {
        let runner = runner.clone();
        tokio::spawn(async move { runner.accept().await.unwrap().await.unwrap() })
    };
    let connection = cubed.connect(runner.addr(), ALPN).await.unwrap();
    let from_cubed = accepting.await.unwrap();
    let dialer = env._net.dialer();
    tokio::spawn(async move {
        while let Ok((mut send, mut recv)) = from_cubed.accept_bi().await {
            let dialer = dialer.clone();
            tokio::spawn(async move {
                let opened: proto::Open = read_frame(&mut recv).await.unwrap();
                let Some(open::Kind::Dial(header)) = opened.kind else {
                    panic!("not a dial stream: {opened:?}");
                };
                let dialed = match dial_port(header.port) {
                    Ok(port) => dial_into(dialer, port).await,
                    Err(error) => Err(error),
                }
                .map(|flow| (flow, Box::new(()) as Box<dyn Send>));
                let _ = serve::dial(dialed, &mut recv, &mut send).await;
            });
        }
    });
    (connection, (runner, cubed))
}

/// Opens a dial stream as cubed's RunnerSession does: the header, then the
/// runner's `StreamAnswer`.
async fn dial(
    connection: &Connection,
    port: u32,
) -> Result<(SendStream, RecvStream), proto::Error> {
    let (mut send, mut recv) = connection.open_bi().await.unwrap();
    let header = proto::DialHeader {
        r#ref: Some(reference()),
        fence: Some(proto::Fence { epoch: 1 }),
        port,
    };
    write_frame(
        &mut send,
        &proto::Open {
            kind: Some(open::Kind::Dial(header)),
        },
    )
    .await
    .unwrap();
    let answer: proto::StreamAnswer = read_frame(&mut recv).await.unwrap();
    match answer.error {
        Some(error) => Err(error),
        None => Ok((send, recv)),
    }
}

fn data(seed: u8) -> Vec<u8> {
    (0..1024 * 1024u32)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect()
}

#[tokio::test]
async fn a_dial_carries_a_mebibyte_each_way_and_each_fin_on_its_own() {
    let env = Env::new(open_policy(Duration::from_secs(60))).await;
    let (connection, _endpoints) = runner(&env).await;

    // cubed sends first and finishes; the guest still answers after the FIN.
    let listening = env.guest.listen(8080);
    let (mut send, mut recv) = dial(&connection, 8080).await.unwrap();
    let mut guest = env.guest.accepted(listening).await;
    let up = data(1);
    let writer = tokio::spawn(async move {
        send.write_all(&up).await.unwrap();
        send.finish().unwrap();
        send
    });
    let mut got = Vec::new();
    guest.read_to_end(&mut got).await.unwrap();
    assert_eq!(Sha256::digest(&got), Sha256::digest(data(1)), "1 MiB up");
    let _send = writer.await.unwrap();
    let down = data(2);
    guest.write_all(&down).await.unwrap();
    guest.shutdown().await.unwrap();
    let got = recv.read_to_end(4 << 20).await.unwrap();
    assert_eq!(Sha256::digest(&got), Sha256::digest(&down), "1 MiB down");

    // The guest sends first and closes its side; cubed still writes after it.
    let listening = env.guest.listen(8081);
    let (mut send, mut recv) = dial(&connection, 8081).await.unwrap();
    let mut guest = env.guest.accepted(listening).await;
    let down = data(3);
    let guest_writes = tokio::spawn(async move {
        guest.write_all(&down).await.unwrap();
        guest.shutdown().await.unwrap();
        guest
    });
    let got = recv.read_to_end(4 << 20).await.unwrap();
    assert_eq!(
        Sha256::digest(&got),
        Sha256::digest(data(3)),
        "FIN from the guest ends cubed's read"
    );
    let mut guest = guest_writes.await.unwrap();
    let up = data(4);
    send.write_all(&up).await.unwrap();
    send.finish().unwrap();
    let mut got = Vec::new();
    guest.read_to_end(&mut got).await.unwrap();
    assert_eq!(
        Sha256::digest(&got),
        Sha256::digest(&up),
        "cubed writes after the guest's FIN"
    );
}

#[tokio::test]
async fn a_dial_is_refused_below_1024_and_where_nothing_listens() {
    let env = Env::new(open_policy(Duration::from_secs(60))).await;
    let (connection, _endpoints) = runner(&env).await;
    for port in [22, 80, 1023, 70000] {
        // Something listens there: the port rule refuses before any SYN.
        let listening = (port < 65536).then(|| env.guest.listen(port as u16));
        let refused = dial(&connection, port).await.err().unwrap();
        assert_eq!(refused.code, Code::PermissionDenied as i32, "{port}");
        assert_eq!(refused.reason, "port");
        if let Some(handle) = listening {
            assert_eq!(
                env.guest.state(handle),
                tcp::State::Listen,
                "no SYN reached the guest"
            );
        }
    }
    let refused = dial(&connection, 9999).await.err().unwrap();
    assert_eq!(refused.code, Code::Unavailable as i32);
    assert_eq!(refused.reason, "dial_failed");
    assert!(
        refused.message.contains("guest refused port 9999"),
        "{}",
        refused.message
    );
}

#[tokio::test]
async fn an_open_dial_ends_when_cubed_goes() {
    let env = Env::new(open_policy(Duration::from_secs(60))).await;
    let (connection, _endpoints) = runner(&env).await;
    let listening = env.guest.listen(8082);
    let (mut send, _recv) = dial(&connection, 8082).await.unwrap();
    let mut guest = env.guest.accepted(listening).await;
    send.write_all(b"hello").await.unwrap();
    let mut first = [0u8; 5];
    guest.read_exact(&mut first).await.unwrap();
    assert_eq!(&first, b"hello");
    connection.close(0u32.into(), b"cubed went");
    // The stream dies with the connection, and the flow with the stream.
    let mut rest = Vec::new();
    let ended = tokio::time::timeout(Duration::from_secs(15), guest.read_to_end(&mut rest)).await;
    assert!(ended.is_ok(), "the guest's connection did not end");
    assert!(rest.is_empty(), "{rest:?}");
}

#[tokio::test]
async fn a_guest_that_does_not_answer_is_given_ten_seconds() {
    let env = Env::new(open_policy(Duration::from_secs(60))).await;
    // A machine's LAN with nobody on QEMU's end: the SYN gets no answer.
    let (silent, _qemu_end) = Net::open(env.gate.clone(), "fedcba9876543210").unwrap();
    let started = std::time::Instant::now();
    let refused = dial_into(silent.dialer(), 8080).await.err().unwrap();
    let waited = started.elapsed();
    assert_eq!(refused.code, Code::Unavailable as i32);
    assert_eq!(refused.reason, "dial_failed");
    assert!(
        refused
            .message
            .contains("guest did not answer on port 8080"),
        "{}",
        refused.message
    );
    assert!(
        waited >= Duration::from_secs(10) && waited < Duration::from_secs(13),
        "{waited:?}"
    );
}
