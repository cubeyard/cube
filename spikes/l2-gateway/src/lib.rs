//! Spike: a VM's Ethernet frames travel as QUIC datagrams over Iroh between a
//! runner-side pump and a central gateway. One frame per datagram.
use anyhow::{Context, Result};
use iroh::{Endpoint, SecretKey, endpoint::presets};
use std::{net::SocketAddr, path::Path};

pub const ALPN: &[u8] = b"cube/l2/0";

/// Reads a 32-byte key, creating it on first use.
pub fn load_key(path: &Path) -> Result<SecretKey> {
    if !path.exists() {
        std::fs::write(path, SecretKey::generate().to_bytes())?;
    }
    let bytes: [u8; 32] = std::fs::read(path)?
        .try_into()
        .ok()
        .context("key file must hold 32 bytes")?;
    Ok(SecretKey::from_bytes(&bytes))
}

/// Direct-address endpoint, no relay or discovery (like the runner's loopback mode).
pub async fn bind(key: SecretKey, listen: SocketAddr, alpns: Vec<Vec<u8>>) -> Result<Endpoint> {
    Ok(Endpoint::builder(presets::Minimal)
        .secret_key(key)
        .alpns(alpns)
        .clear_ip_transports()
        .clear_relay_transports()
        .clear_address_lookup()
        .bind_addr(listen)?
        .bind()
        .await?)
}

/// A frame larger than one QUIC datagram is split. Header: frame id (u16),
/// then index in the high nibble and fragment count in the low nibble. A lost
/// fragment loses the whole frame, which the guest's TCP treats as packet loss.
pub const FRAGMENT_HEADER: usize = 3;

#[derive(Default)]
pub struct Fragmenter {
    next: u16,
}
impl Fragmenter {
    pub fn split(&mut self, frame: &[u8], max_datagram: usize) -> Vec<bytes::Bytes> {
        let room = max_datagram - FRAGMENT_HEADER;
        let count = frame.len().div_ceil(room).max(1);
        assert!(count <= 15, "frame too large for fragmentation");
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

/// Keeps a few partial frames; datagrams may arrive reordered.
#[derive(Default)]
pub struct Reassembler {
    partial: std::collections::VecDeque<(u16, Vec<Option<bytes::Bytes>>)>,
}
impl Reassembler {
    pub fn push(&mut self, datagram: bytes::Bytes) -> Option<bytes::Bytes> {
        if datagram.len() < FRAGMENT_HEADER {
            return None;
        }
        let id = u16::from_be_bytes([datagram[0], datagram[1]]);
        let (index, count) = ((datagram[2] >> 4) as usize, (datagram[2] & 0x0f) as usize);
        let body = datagram.slice(FRAGMENT_HEADER..);
        if count == 1 {
            return Some(body);
        }
        if index >= count {
            return None;
        }
        let slot = match self.partial.iter().position(|(i, p)| *i == id && p.len() == count) {
            Some(s) => s,
            None => {
                if self.partial.len() == 32 {
                    self.partial.pop_front();
                }
                self.partial.push_back((id, vec![None; count]));
                self.partial.len() - 1
            }
        };
        self.partial[slot].1[index] = Some(body);
        if self.partial[slot].1.iter().all(Option::is_some) {
            let (_, parts) = self.partial.remove(slot)?;
            let mut frame = Vec::new();
            for p in parts.into_iter().flatten() {
                frame.extend_from_slice(&p);
            }
            return Some(frame.into());
        }
        None
    }
}
