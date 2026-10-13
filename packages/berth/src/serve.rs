//! What every berth mode shares: one authenticated Iroh connection from
//! cubed, one QUIC stream per call (packages/runner-protocol/proto/runner.proto),
//! and the watch stream. A mode (`host`, `vm`) answers the streams through
//! [`Service`].
use std::{future::Future, sync::Arc};

use anyhow::Result;
use cube_runner_protocol::{
    ALPN,
    proto::{self, Code, open, watch_event},
    read_frame, refuse, write_frame,
};
use iroh::{
    Endpoint, EndpointId,
    endpoint::{Connection, RecvStream, SendStream},
};
use tokio::{sync::broadcast, task::JoinSet, time::timeout};

/// One berth mode's answers to the streams of runner protocol 4.
pub trait Service: Send + Sync + 'static {
    /// `host_runner` or `vm_runner`: the reason of what this mode does not do.
    const KIND: &'static str;
    fn hello(&self, hello: &proto::Hello) -> Result<proto::HelloAnswer, proto::Error>;
    fn call(self: Arc<Self>, call: proto::Call) -> impl Future<Output = proto::CallResult> + Send;
    fn watch(self: Arc<Self>, send: &mut SendStream) -> impl Future<Output = Result<()>> + Send;
    /// A guest operation's answer bytes; `send` is only watched (for cubed
    /// stopping to read), the caller writes the answer.
    fn guest(
        self: Arc<Self>,
        header: proto::GuestHeader,
        recv: &mut RecvStream,
        send: &mut SendStream,
    ) -> impl Future<Output = Result<Vec<u8>, proto::Error>> + Send;
    /// Called once when the runner starts serving.
    fn serving(self: &Arc<Self>) {}
    /// Called for each authenticated connection from cubed; what it returns
    /// is dropped when the connection ends (`berth vm`: cubed's presence
    /// for the egress lease, and the report stream).
    fn attach(self: &Arc<Self>, _connection: &Connection) -> Box<dyn Send> {
        Box::new(())
    }
}

/// Every resource as PUT after a RESET, then a BOOKMARK, then each change;
/// a reader too slow for `events` starts over with a new snapshot.
pub async fn watch(
    send: &mut SendStream,
    events: &broadcast::Sender<proto::WatchEvent>,
    snapshot: impl Fn() -> (i64, Vec<watch_event::Resource>),
) -> Result<()> {
    let mut events = events.subscribe();
    loop {
        let (version, resources) = snapshot();
        let event = |r#type: watch_event::Type, resource| proto::WatchEvent {
            r#type: r#type as i32,
            version,
            resource,
        };
        write_frame(send, &event(watch_event::Type::Reset, None)).await?;
        for resource in resources {
            write_frame(send, &event(watch_event::Type::Put, Some(resource))).await?;
        }
        write_frame(send, &event(watch_event::Type::Bookmark, None)).await?;
        loop {
            match events.recv().await {
                Ok(event) => write_frame(send, &event).await?,
                Err(broadcast::error::RecvError::Lagged(_)) => break,
                Err(broadcast::error::RecvError::Closed) => return Ok(()),
            }
        }
    }
}

/// Answers the streams of one authenticated connection.
async fn serve_connection(service: Arc<impl Service>, connection: Connection) {
    let _attached = service.attach(&connection);
    while let Ok((mut send, mut recv)) = connection.accept_bi().await {
        let service = service.clone();
        tokio::spawn(async move {
            let _ = stream(service, &mut send, &mut recv).await;
        });
    }
}

/// UNIMPLEMENTED for what mode `S` does not do ("a host runner has no dial").
pub fn unimplemented<S: Service>(what: &str) -> proto::Error {
    refuse(
        Code::Unimplemented,
        S::KIND,
        &format!("a {} has no {what}", S::KIND.replace('_', " ")),
    )
}

async fn stream<S: Service>(
    service: Arc<S>,
    send: &mut SendStream,
    recv: &mut RecvStream,
) -> Result<()> {
    let answer = |error: Option<proto::Error>| proto::StreamAnswer { error };
    let opened: proto::Open = match read_frame(recv).await {
        Ok(opened) => opened,
        Err(error) => {
            write_frame(
                send,
                &answer(Some(refuse(
                    Code::InvalidArgument,
                    "open",
                    &error.to_string(),
                ))),
            )
            .await?;
            send.finish()?;
            return Ok(());
        }
    };
    match opened.kind {
        Some(open::Kind::Hello(hello)) => match service.hello(&hello) {
            Ok(hello) => write_frame(send, &hello).await?,
            Err(error) => write_frame(send, &answer(Some(error))).await?,
        },
        Some(open::Kind::Call(call)) => write_frame(send, &service.call(call).await).await?,
        Some(open::Kind::Watch(_)) => return service.watch(send).await,
        Some(open::Kind::Guest(header)) => match service.guest(header, recv, send).await {
            Ok(bytes) => {
                write_frame(send, &answer(None)).await?;
                send.write_all(&bytes).await?;
            }
            Err(error) => write_frame(send, &answer(Some(error))).await?,
        },
        Some(open::Kind::Dial(_)) => {
            write_frame(send, &answer(Some(unimplemented::<S>("dial")))).await?
        }
        // Runner -> cubed only.
        Some(open::Kind::Report(_) | open::Kind::Credential(_)) => {
            write_frame(
                send,
                &answer(Some(refuse(
                    Code::InvalidArgument,
                    "open",
                    "report and credential streams are opened by the runner",
                ))),
            )
            .await?
        }
        None => {
            write_frame(
                send,
                &answer(Some(refuse(
                    Code::InvalidArgument,
                    "open",
                    "unknown stream",
                ))),
            )
            .await?
        }
    }
    send.finish()?;
    Ok(())
}

/// At most this many connections at once (cubed keeps one).
const MAX_CONNECTIONS: usize = 16;
/// A connection must finish its handshake within this.
const HANDSHAKE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Accepts protocol-4 connections from `allowed` only; each stream is one
/// call (see packages/runner-protocol/proto/runner.proto).
pub async fn serve(
    endpoint: &Endpoint,
    allowed: EndpointId,
    service: Arc<impl Service>,
) -> Result<()> {
    service.serving();
    let mut connections = JoinSet::new();
    loop {
        tokio::select! {
            incoming = endpoint.accept() => {
                let Some(incoming) = incoming else { break };
                if connections.len() >= MAX_CONNECTIONS {
                    incoming.refuse();
                    continue;
                }
                let service = service.clone();
                connections.spawn(async move {
                    let Ok(Ok(connection)) = timeout(HANDSHAKE_TIMEOUT, incoming).await else { return };
                    if connection.remote_id() != allowed || connection.alpn() != ALPN {
                        connection.close(1u32.into(), b"UNAUTHORIZED");
                        return;
                    }
                    serve_connection(service, connection).await;
                });
            }
            Some(_) = connections.join_next(), if !connections.is_empty() => {}
        }
    }
    connections.abort_all();
    while connections.join_next().await.is_some() {}
    Ok(())
}
