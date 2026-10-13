//! The phone's name lookups, answered here so they never leave the phone.
//!
//! An app asks "where is example.com?". If that question went to the phone's
//! usual DNS server it would leave with the phone's real address (a DNS leak),
//! and the answer would be the address seen from here, not from the proxy's
//! country. So every lookup gets a stand-in address from 198.18.0.0/15, a block
//! set aside for tests that is never used on the internet, and the name is
//! remembered with it. When the app then connects to the stand-in, the tunnel
//! asks the relay for the NAME, and the proxy looks it up where it is.
//!
//! Only A questions (IPv4) get an address. Every other kind (AAAA, HTTPS, MX,
//! ...) is answered "no records", so apps connect over IPv4 through a name the
//! tunnel knows.

use std::collections::HashMap;
use std::net::Ipv4Addr;

/// The VPN's own address, its DNS server, and the stand-ins, all in 198.18.0.0/15.
pub const FAKE_NET: Ipv4Addr = Ipv4Addr::new(198, 18, 0, 0);
pub const FAKE_PREFIX: u8 = 15;
/// The first stand-in; .0 is the network, .1 the VPN, .2 the DNS server.
const FIRST: u32 = 3;
/// One past the last stand-in (198.19.255.255 is left alone).
const END: u32 = 1 << (32 - FAKE_PREFIX as u32);
/// How long an app may keep an answer, in seconds. Short, as other VPN apps
/// do it: the stand-in for a name can be reused much later.
const TTL: u32 = 60;

/// Names and their stand-ins, both ways.
#[derive(Default)]
pub struct FakeDns {
    by_name: HashMap<String, u32>,
    by_offset: HashMap<u32, String>,
    next: u32,
}

impl FakeDns {
    /// The stand-in for a name, the same one every time while it is kept.
    /// After 131 069 names the oldest stand-ins are given out again.
    pub fn address_for(&mut self, name: &str) -> Ipv4Addr {
        let name = name.trim_end_matches('.').to_ascii_lowercase();
        if let Some(&offset) = self.by_name.get(&name) {
            return at(offset);
        }
        if self.next < FIRST || self.next >= END {
            self.next = FIRST;
        }
        let offset = self.next;
        self.next += 1;
        if let Some(old) = self.by_offset.insert(offset, name.clone()) {
            self.by_name.remove(&old);
        }
        self.by_name.insert(name, offset);
        at(offset)
    }

    /// The name behind a stand-in, when it is one.
    pub fn name_of(&self, ip: Ipv4Addr) -> Option<&str> {
        let offset = u32::from(ip).checked_sub(u32::from(FAKE_NET))?;
        self.by_offset.get(&offset).map(String::as_str)
    }

    /// The answer to one DNS question over UDP, or nothing when the bytes are
    /// not a question at all.
    pub fn answer(&mut self, query: &[u8]) -> Option<Vec<u8>> {
        let q = Question::read(query)?;
        let mut out = Vec::with_capacity(q.end + 16);
        out.extend_from_slice(&query[0..2]); // the same id
                                             // A response; the same opcode and "recursion desired"; recursion available.
        let opcode = query[2] & 0x78;
        let rd = query[2] & 0x01;
        out.push(0x80 | opcode | rd);
        let rcode = match (opcode, &q.name) {
            (0, Some(_)) => 0,
            (0, None) => 1, // FORMERR: a question we could not read
            _ => 4,         // NOTIMP: not a standard query
        };
        out.push(0x80 | rcode);
        let address = match (&q.name, q.qtype, q.qclass, rcode) {
            (Some(name), 1, 1, 0) => Some(self.address_for(name)),
            _ => None,
        };
        let has_question = q.name.is_some();
        out.extend_from_slice(&[0, has_question as u8, 0, address.is_some() as u8, 0, 0, 0, 0]);
        if has_question {
            out.extend_from_slice(&query[12..q.end]);
        }
        if let Some(ip) = address {
            out.extend_from_slice(&[0xc0, 0x0c, 0, 1, 0, 1]); // the name in the question, A, IN
            out.extend_from_slice(&TTL.to_be_bytes());
            out.extend_from_slice(&[0, 4]);
            out.extend_from_slice(&ip.octets());
        }
        Some(out)
    }
}

fn at(offset: u32) -> Ipv4Addr {
    Ipv4Addr::from(u32::from(FAKE_NET) + offset)
}

/// The first question of a query: its name, type and class, and where it ends.
struct Question {
    name: Option<String>,
    qtype: u16,
    qclass: u16,
    end: usize,
}

impl Question {
    fn read(m: &[u8]) -> Option<Question> {
        if m.len() < 12 || m[2] & 0x80 != 0 {
            return None; // too short, or an answer rather than a question
        }
        let none = Question {
            name: None,
            qtype: 0,
            qclass: 0,
            end: 12,
        };
        if u16::from_be_bytes([m[4], m[5]]) == 0 {
            return Some(none);
        }
        // The name: labels, each with its length first, ending with 0. A
        // question never points elsewhere in the message, so a pointer is refused.
        let mut labels: Vec<String> = Vec::new();
        let mut i = 12;
        loop {
            let len = *m.get(i)? as usize;
            if len == 0 {
                i += 1;
                break;
            }
            if len > 63 || labels.iter().map(|l| l.len() + 1).sum::<usize>() + len > 253 {
                return Some(none);
            }
            let label = m.get(i + 1..i + 1 + len)?;
            if !label.iter().all(|b| b.is_ascii_graphic()) {
                return Some(none);
            }
            labels.push(String::from_utf8_lossy(label).into_owned());
            i += 1 + len;
        }
        let tail = m.get(i..i + 4)?;
        Some(Question {
            name: Some(labels.join(".")),
            qtype: u16::from_be_bytes([tail[0], tail[1]]),
            qclass: u16::from_be_bytes([tail[2], tail[3]]),
            end: i + 4,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A query as a phone sends it, with an EDNS record after the question.
    fn query(id: u16, name: &str, qtype: u16) -> Vec<u8> {
        let mut m = id.to_be_bytes().to_vec();
        m.extend_from_slice(&[0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 1]);
        for label in name.split('.') {
            m.push(label.len() as u8);
            m.extend_from_slice(label.as_bytes());
        }
        m.push(0);
        m.extend_from_slice(&qtype.to_be_bytes());
        m.extend_from_slice(&[0, 1]);
        m.extend_from_slice(&[0, 0, 41, 4, 208, 0, 0, 0, 0, 0, 0]); // EDNS
        m
    }

    #[test]
    fn a_name_gets_a_stand_in_and_keeps_it() {
        let mut dns = FakeDns::default();
        let a = dns.address_for("example.com");
        assert_eq!(a, Ipv4Addr::new(198, 18, 0, 3));
        assert_eq!(dns.address_for("Example.COM."), a);
        assert_eq!(dns.address_for("hproxy.com"), Ipv4Addr::new(198, 18, 0, 4));
        assert_eq!(dns.name_of(a), Some("example.com"));
        assert_eq!(dns.name_of(Ipv4Addr::new(8, 8, 8, 8)), None);
        assert_eq!(dns.name_of(Ipv4Addr::new(198, 18, 0, 200)), None);
    }

    #[test]
    fn an_a_question_is_answered_with_the_stand_in() {
        let mut dns = FakeDns::default();
        let q = query(0xbeef, "www.google.com", 1);
        let a = dns.answer(&q).unwrap();
        assert_eq!(&a[0..2], &[0xbe, 0xef]);
        assert_eq!(a[2] & 0x80, 0x80, "a response");
        assert_eq!(a[2] & 0x01, 0x01, "recursion desired is kept");
        assert_eq!(a[3] & 0x0f, 0, "no error");
        assert_eq!(
            &a[4..12],
            &[0, 1, 0, 1, 0, 0, 0, 0],
            "one question, one answer, no EDNS echoed"
        );
        assert_eq!(&a[a.len() - 4..], &[198, 18, 0, 3]);
        assert_eq!(dns.name_of(Ipv4Addr::new(198, 18, 0, 3)), Some("www.google.com"));
    }

    #[test]
    fn other_kinds_of_question_get_no_records() {
        let mut dns = FakeDns::default();
        for qtype in [
            28, /* AAAA */
            65, /* HTTPS */
            15, /* MX */
            12, /* PTR */
        ] {
            let a = dns.answer(&query(7, "example.com", qtype)).unwrap();
            assert_eq!(a[3] & 0x0f, 0, "no error");
            assert_eq!(&a[6..8], &[0, 0], "no answers for type {qtype}");
        }
        assert_eq!(dns.name_of(Ipv4Addr::new(198, 18, 0, 3)), None, "no stand-in given out");
    }

    #[test]
    fn bytes_that_are_not_a_question_get_no_answer_or_an_error() {
        let mut dns = FakeDns::default();
        assert!(dns.answer(&[1, 2, 3]).is_none());
        let mut response = query(1, "a.com", 1);
        response[2] |= 0x80;
        assert!(dns.answer(&response).is_none(), "an answer is never answered");
        let mut pointer = query(1, "a.com", 1);
        pointer[12] = 0xc0;
        let a = dns.answer(&pointer).unwrap();
        assert_eq!(a[3] & 0x0f, 1, "FORMERR");
        let mut update = query(1, "a.com", 1);
        update[2] = 0x28; // opcode 5, an update
        assert_eq!(dns.answer(&update).unwrap()[3] & 0x0f, 4, "NOTIMP");
    }

    #[test]
    fn stand_ins_are_reused_after_the_block_runs_out() {
        let mut dns = FakeDns::default();
        let first = dns.address_for("first.example");
        for i in 0..(END - FIRST - 1) {
            dns.address_for(&format!("n{i}.example"));
        }
        let again = dns.address_for("late.example");
        assert_eq!(again, first, "the oldest stand-in comes back");
        assert_eq!(dns.name_of(first), Some("late.example"));
        assert_ne!(dns.address_for("first.example"), first, "the old name gets a new one");
    }
}
