//! Frame channel between a runner and `cube-gateway`: a VM's raw Ethernet
//! frames travel as QUIC datagrams over Iroh, ALPN `cube/l2/1`.
//!
//! The gateway dials the runner, opens one bi-stream and sends a
//! [`FrameHello`] (length-prefixed JSON, then FIN). The runner checks the
//! peer, the VM and the frame token named by the latest accepted `vm.start`
//! and answers [`FrameReady`]. After that, datagrams in both directions are
//! Ethernet frames split by [`Fragmenter`] and joined by [`Reassembler`].
use anyhow::{Result, ensure};
use bytes::Bytes;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;

use crate::{encode, read_frame};

pub const L2_ALPN: &[u8] = b"cube/l2/1";
/// Guest MTU. Frames are fragmented over datagrams, so the guest keeps the
/// normal Ethernet MTU even though one QUIC datagram holds ~1160-1410 bytes.
pub const GUEST_MTU: u16 = 1500;
/// Largest Ethernet frame accepted on the channel (MTU + 14-byte header;
/// no VLAN tags).
pub const MAX_FRAME: usize = GUEST_MTU as usize + 14;
/// Smallest datagram size the fragmenter works with. QUIC guarantees 1200
/// bytes of UDP payload, which leaves at least this much for a datagram.
pub const MIN_DATAGRAM: usize = 1100;

/// Sent by the gateway on the first bi-stream of a frame connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameHello {
    pub vm_id: String,
    pub thread_id: String,
    /// 64 lowercase hex characters, minted by cubed per `vm.start`.
    pub frame_token: String,
}

/// The runner's answer. `ok: false` carries `error` and the runner then
/// closes the connection.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FrameReady {
    pub ok: bool,
    pub mtu: u16,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

impl FrameReady {
    pub fn accepted() -> Self {
        Self {
            ok: true,
            mtu: GUEST_MTU,
            error: None,
        }
    }
    pub fn refused(error: &str) -> Self {
        Self {
            ok: false,
            mtu: GUEST_MTU,
            error: Some(error.into()),
        }
    }
}

pub fn valid_frame_token(token: &str) -> bool {
    token.len() == 64
        && token
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Gateway side: sends the hello on a fresh bi-stream and returns the
/// runner's answer.
pub async fn send_hello(
    connection: &iroh::endpoint::Connection,
    hello: &FrameHello,
) -> Result<FrameReady> {
    let (mut send, mut recv) = connection.open_bi().await?;
    send.write_all(&encode(hello)?).await?;
    send.finish()?;
    read_frame(&mut recv).await
}

/// Runner side: reads the hello from the first bi-stream. The caller
/// authorizes it and answers with [`answer_hello`].
pub async fn accept_hello(
    connection: &iroh::endpoint::Connection,
) -> Result<(FrameHello, iroh::endpoint::SendStream)> {
    let (send, mut recv) = connection.accept_bi().await?;
    let hello: FrameHello = read_frame(&mut recv).await?;
    ensure!(
        valid_frame_token(&hello.frame_token),
        "invalid frame token format"
    );
    Ok((hello, send))
}

pub async fn answer_hello(mut send: iroh::endpoint::SendStream, ready: &FrameReady) -> Result<()> {
    send.write_all(&encode(ready)?).await?;
    send.finish()?;
    Ok(())
}

/// Constant-time comparison for frame tokens and their hashes.
pub fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

/// Header per datagram: frame id (u16 big endian), then fragment index in the
/// high nibble and fragment count in the low nibble. A lost fragment loses
/// the whole frame, which the guest's TCP treats as packet loss.
pub const FRAGMENT_HEADER: usize = 3;
const MAX_FRAGMENTS: usize = 15;
const PARTIAL_FRAMES: usize = 32;

#[derive(Default)]
pub struct Fragmenter {
    next: u16,
}

impl Fragmenter {
    /// Splits a frame into datagrams of at most `max_datagram` bytes. Returns
    /// nothing for frames that are empty or would need more than 15
    /// fragments (never the case for frames up to [`MAX_FRAME`] bytes).
    pub fn split(&mut self, frame: &[u8], max_datagram: usize) -> Vec<Bytes> {
        let max_datagram = max_datagram.max(MIN_DATAGRAM);
        let room = max_datagram - FRAGMENT_HEADER;
        let count = frame.len().div_ceil(room);
        if count == 0 || count > MAX_FRAGMENTS {
            return vec![];
        }
        let id = self.next;
        self.next = self.next.wrapping_add(1);
        frame
            .chunks(room)
            .enumerate()
            .map(|(i, chunk)| {
                let mut d = Vec::with_capacity(FRAGMENT_HEADER + chunk.len());
                d.extend_from_slice(&id.to_be_bytes());
                d.push(((i as u8) << 4) | count as u8);
                d.extend_from_slice(chunk);
                d.into()
            })
            .collect()
    }
}

/// Sends one frame or drops all of it. `send_datagram` would instead evict
/// the oldest queued datagrams when the connection is congested, which
/// silently tears earlier frames apart. Dropping the newest whole frame is
/// what a full router queue does; the guest's TCP sees ordinary loss.
/// Returns false when the frame was dropped.
pub fn send_frame(
    connection: &iroh::endpoint::Connection,
    fragmenter: &mut Fragmenter,
    frame: &[u8],
) -> bool {
    let Some(max) = connection.max_datagram_size() else {
        return false;
    };
    let datagrams = fragmenter.split(frame, max);
    let total: usize = datagrams.iter().map(Bytes::len).sum();
    if connection.datagram_send_buffer_space() < total {
        return false;
    }
    datagrams
        .into_iter()
        .all(|datagram| connection.send_datagram(datagram).is_ok())
}

/// Keeps a few partial frames; datagrams may arrive reordered or not at all.
#[derive(Default)]
pub struct Reassembler {
    partial: VecDeque<(u16, Vec<Option<Bytes>>)>,
}

impl Reassembler {
    pub fn push(&mut self, datagram: Bytes) -> Option<Bytes> {
        if datagram.len() <= FRAGMENT_HEADER {
            return None;
        }
        let id = u16::from_be_bytes([datagram[0], datagram[1]]);
        let (index, count) = ((datagram[2] >> 4) as usize, (datagram[2] & 0x0f) as usize);
        let body = datagram.slice(FRAGMENT_HEADER..);
        if count == 0 || index >= count {
            return None;
        }
        if count == 1 {
            return (body.len() <= MAX_FRAME).then_some(body);
        }
        let slot = match self
            .partial
            .iter()
            .position(|(i, p)| *i == id && p.len() == count)
        {
            Some(s) => s,
            None => {
                if self.partial.len() == PARTIAL_FRAMES {
                    self.partial.pop_front();
                }
                self.partial.push_back((id, vec![None; count]));
                self.partial.len() - 1
            }
        };
        self.partial[slot].1[index] = Some(body);
        if self.partial[slot].1.iter().all(Option::is_some) {
            let (_, parts) = self.partial.remove(slot)?;
            let size: usize = parts.iter().flatten().map(Bytes::len).sum();
            if size > MAX_FRAME {
                return None;
            }
            let mut frame = Vec::with_capacity(size);
            for p in parts.into_iter().flatten() {
                frame.extend_from_slice(&p);
            }
            return Some(frame.into());
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn frame(len: usize) -> Vec<u8> {
        (0..len).map(|i| (i % 251) as u8).collect()
    }

    #[test]
    fn small_frames_take_one_datagram() {
        let mut f = Fragmenter::default();
        let parts = f.split(&frame(60), 1200);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].len(), 63);
        assert_eq!(parts[0][2], 0x01);
        let mut r = Reassembler::default();
        assert_eq!(r.push(parts[0].clone()).unwrap(), frame(60));
    }

    #[test]
    fn full_frames_split_and_join_in_any_order() {
        let mut f = Fragmenter::default();
        let mut r = Reassembler::default();
        let original = frame(MAX_FRAME);
        let parts = f.split(&original, 1160);
        assert_eq!(parts.len(), 2);
        assert!(parts.iter().all(|p| p.len() <= 1160));
        assert!(r.push(parts[1].clone()).is_none());
        assert_eq!(r.push(parts[0].clone()).unwrap(), original);
    }

    #[test]
    fn interleaved_frames_and_lost_fragments() {
        let mut f = Fragmenter::default();
        let mut r = Reassembler::default();
        let a = f.split(&frame(1500), 1100);
        let b = f.split(&frame(1400), 1100);
        let lost = f.split(&frame(1300), 1100);
        assert!(r.push(lost[0].clone()).is_none());
        assert!(r.push(a[0].clone()).is_none());
        assert!(r.push(b[0].clone()).is_none());
        assert_eq!(r.push(b[1].clone()).unwrap(), frame(1400));
        assert_eq!(r.push(a[1].clone()).unwrap(), frame(1500));
        // A stream of later frames evicts the incomplete one.
        for _ in 0..PARTIAL_FRAMES {
            let p = f.split(&frame(1500), 1100);
            r.push(p[0].clone());
        }
        assert!(r.push(lost[1].clone()).is_none());
    }

    #[test]
    fn malformed_datagrams_are_ignored() {
        let mut r = Reassembler::default();
        assert!(r.push(Bytes::from_static(&[0, 1])).is_none());
        assert!(r.push(Bytes::from_static(&[0, 1, 0x01])).is_none());
        assert!(r.push(Bytes::from_static(&[0, 1, 0x00, 9])).is_none());
        assert!(r.push(Bytes::from_static(&[0, 1, 0x22, 9])).is_none());
        let oversized = [&[0u8, 1, 0x01][..], &frame(MAX_FRAME + 1)].concat();
        assert!(r.push(oversized.into()).is_none());
        assert!(Fragmenter::default().split(&[], 1200).is_empty());
    }

    #[test]
    fn ids_wrap() {
        let mut f = Fragmenter { next: u16::MAX };
        assert_eq!(&f.split(&frame(10), 1200)[0][..2], &[0xff, 0xff]);
        assert_eq!(&f.split(&frame(10), 1200)[0][..2], &[0, 0]);
    }

    #[test]
    fn hello_shapes() {
        let hello = FrameHello {
            vm_id: "0123456789abcdef".into(),
            thread_id: "t1".into(),
            frame_token: "a".repeat(64),
        };
        let json = serde_json::to_value(&hello).unwrap();
        assert_eq!(json["vmId"], "0123456789abcdef");
        assert_eq!(json["frameToken"], "a".repeat(64));
        assert!(valid_frame_token(&hello.frame_token));
        assert!(!valid_frame_token(&"A".repeat(64)));
        assert!(!valid_frame_token("ab"));
        assert_eq!(
            serde_json::to_value(FrameReady::accepted()).unwrap(),
            serde_json::json!({"ok": true, "mtu": 1500})
        );
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }
}
