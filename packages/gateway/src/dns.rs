//! The guest's resolver at 10.77.0.1:53. A queries are answered from the
//! gateway's own resolver (TTL 30), AAAA gets an empty NOERROR (the LAN has no
//! IPv6), everything else NOTIMP. Only single-question standard queries.
use std::net::Ipv4Addr;

pub const TTL: u32 = 30;
const TYPE_A: u16 = 1;
const TYPE_AAAA: u16 = 28;
const CLASS_IN: u16 = 1;
const RCODE_SERVFAIL: u8 = 2;
const RCODE_NXDOMAIN: u8 = 3;
const RCODE_NOTIMP: u8 = 4;
const RCODE_FORMERR: u8 = 1;

#[derive(Debug, PartialEq, Eq)]
pub struct Query {
    pub id: u16,
    /// Lowercase, dot-separated, without the trailing dot.
    pub name: String,
    pub qtype: u16,
    qclass: u16,
    recursion_desired: bool,
    /// The question section as received, echoed in the answer.
    question: Vec<u8>,
}

impl Query {
    pub fn wants_a(&self) -> bool {
        self.qtype == TYPE_A && self.qclass == CLASS_IN
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Answer {
    A(Vec<Ipv4Addr>),
    /// AAAA and other in-class types the LAN does not serve.
    Empty,
    NotImplemented,
    NxDomain,
    ServFail,
}

/// Parses a standard query with one question. `Err` holds a FORMERR/NOTIMP
/// reply when the ID could be read, `None` when not even a header was there.
pub fn parse(packet: &[u8]) -> Result<Query, Option<Vec<u8>>> {
    if packet.len() < 12 {
        return Err(None);
    }
    let id = u16::from_be_bytes([packet[0], packet[1]]);
    let flags = u16::from_be_bytes([packet[2], packet[3]]);
    let qdcount = u16::from_be_bytes([packet[4], packet[5]]);
    let is_response = flags & 0x8000 != 0;
    let opcode = (flags >> 11) & 0x0f;
    let rd = flags & 0x0100 != 0;
    if is_response {
        return Err(None);
    }
    let error = |rcode| Err(Some(header_only(id, rd, opcode as u8, rcode)));
    if opcode != 0 {
        return error(RCODE_NOTIMP);
    }
    if qdcount != 1 {
        return error(RCODE_FORMERR);
    }
    let mut i = 12;
    let mut labels: Vec<String> = vec![];
    loop {
        let Some(&len) = packet.get(i) else {
            return error(RCODE_FORMERR);
        };
        i += 1;
        if len == 0 {
            break;
        }
        // Compression pointers are not valid in a query's only question.
        if len & 0xc0 != 0 || labels.len() >= 127 {
            return error(RCODE_FORMERR);
        }
        let Some(label) = packet.get(i..i + len as usize) else {
            return error(RCODE_FORMERR);
        };
        if !label
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || *b == b'-' || *b == b'_')
        {
            return error(RCODE_FORMERR);
        }
        labels.push(String::from_utf8_lossy(label).to_ascii_lowercase());
        i += len as usize;
    }
    let name = labels.join(".");
    if name.len() > 253 {
        return error(RCODE_FORMERR);
    }
    let Some(tail) = packet.get(i..i + 4) else {
        return error(RCODE_FORMERR);
    };
    Ok(Query {
        id,
        name,
        qtype: u16::from_be_bytes([tail[0], tail[1]]),
        qclass: u16::from_be_bytes([tail[2], tail[3]]),
        recursion_desired: rd,
        question: packet[12..i + 4].to_vec(),
    })
}

fn header(id: u16, rd: bool, opcode: u8, rcode: u8, qd: u16, an: u16) -> Vec<u8> {
    let mut flags: u16 = 0x8000 | ((opcode as u16 & 0x0f) << 11) | 0x0080 | rcode as u16;
    if rd {
        flags |= 0x0100;
    }
    let mut out = Vec::with_capacity(512);
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&flags.to_be_bytes());
    out.extend_from_slice(&qd.to_be_bytes());
    out.extend_from_slice(&an.to_be_bytes());
    out.extend_from_slice(&[0, 0, 0, 0]);
    out
}

fn header_only(id: u16, rd: bool, opcode: u8, rcode: u8) -> Vec<u8> {
    header(id, rd, opcode, rcode, 0, 0)
}

/// Builds the reply for `query`. At most 16 addresses fit comfortably in
/// one 512-byte UDP answer.
pub fn reply(query: &Query, answer: &Answer) -> Vec<u8> {
    let (rcode, addresses): (u8, &[Ipv4Addr]) = match answer {
        Answer::A(a) => (0, &a[..a.len().min(16)]),
        Answer::Empty => (0, &[]),
        Answer::NotImplemented => (RCODE_NOTIMP, &[]),
        Answer::NxDomain => (RCODE_NXDOMAIN, &[]),
        Answer::ServFail => (RCODE_SERVFAIL, &[]),
    };
    let mut out = header(
        query.id,
        query.recursion_desired,
        0,
        rcode,
        1,
        addresses.len() as u16,
    );
    out.extend_from_slice(&query.question);
    for address in addresses {
        out.extend_from_slice(&[0xc0, 0x0c]); // name: pointer to the question
        out.extend_from_slice(&TYPE_A.to_be_bytes());
        out.extend_from_slice(&CLASS_IN.to_be_bytes());
        out.extend_from_slice(&TTL.to_be_bytes());
        out.extend_from_slice(&4u16.to_be_bytes());
        out.extend_from_slice(&address.octets());
    }
    out
}

/// What the LAN answers without resolving anything.
pub fn immediate(query: &Query) -> Option<Answer> {
    if query.qclass != CLASS_IN {
        return Some(Answer::NotImplemented);
    }
    match query.qtype {
        TYPE_A
            if query.name.is_empty() || !query.name.contains('.') && query.name != "localhost" =>
        {
            Some(Answer::NxDomain)
        }
        TYPE_A => None,
        TYPE_AAAA => Some(Answer::Empty),
        _ => Some(Answer::NotImplemented),
    }
}

#[cfg(test)]
pub fn build_query(id: u16, name: &str, qtype: u16) -> Vec<u8> {
    let mut out = vec![];
    out.extend_from_slice(&id.to_be_bytes());
    out.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0]);
    for label in name.split('.') {
        out.push(label.len() as u8);
        out.extend_from_slice(label.as_bytes());
    }
    out.push(0);
    out.extend_from_slice(&qtype.to_be_bytes());
    out.extend_from_slice(&CLASS_IN.to_be_bytes());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_query_round_trip() {
        let packet = build_query(0x1234, "API.GitHub.com", TYPE_A);
        let query = parse(&packet).unwrap();
        assert_eq!(query.name, "api.github.com");
        assert!(query.wants_a());
        assert_eq!(immediate(&query), None);
        let reply = reply(&query, &Answer::A(vec![Ipv4Addr::new(140, 82, 112, 6)]));
        assert_eq!(&reply[..2], &[0x12, 0x34]);
        assert_eq!(reply[3] & 0x0f, 0, "NOERROR");
        assert_eq!(u16::from_be_bytes([reply[6], reply[7]]), 1, "one answer");
        assert_eq!(&reply[reply.len() - 4..], &[140, 82, 112, 6]);
        assert_eq!(
            &reply[reply.len() - 10..reply.len() - 6],
            &TTL.to_be_bytes()
        );
    }

    #[test]
    fn aaaa_is_empty_and_others_not_implemented() {
        let aaaa = parse(&build_query(1, "example.com", TYPE_AAAA)).unwrap();
        assert_eq!(immediate(&aaaa), Some(Answer::Empty));
        let r = reply(&aaaa, &Answer::Empty);
        assert_eq!(r[3] & 0x0f, 0);
        assert_eq!(u16::from_be_bytes([r[6], r[7]]), 0);
        let mx = parse(&build_query(1, "example.com", 15)).unwrap();
        assert_eq!(immediate(&mx), Some(Answer::NotImplemented));
        assert_eq!(reply(&mx, &Answer::NotImplemented)[3] & 0x0f, RCODE_NOTIMP);
        // Single-label names never leave the gateway.
        let single = parse(&build_query(1, "wpad", TYPE_A)).unwrap();
        assert_eq!(immediate(&single), Some(Answer::NxDomain));
    }

    #[test]
    fn malformed_queries() {
        assert_eq!(parse(&[0; 4]), Err(None));
        let mut response = build_query(7, "a.b", TYPE_A);
        response[2] |= 0x80;
        assert_eq!(parse(&response), Err(None));
        let mut truncated = build_query(7, "a.b", TYPE_A);
        truncated.truncate(truncated.len() - 2);
        let Err(Some(r)) = parse(&truncated) else {
            panic!()
        };
        assert_eq!(r[3] & 0x0f, RCODE_FORMERR);
        let mut pointer = build_query(7, "a.b", TYPE_A);
        pointer[12] = 0xc0;
        assert!(matches!(parse(&pointer), Err(Some(_))));
    }
}
