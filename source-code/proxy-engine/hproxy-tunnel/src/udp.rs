//! UDP flows other than DNS. An HTTP proxy cannot carry them, so one meant for
//! the proxy is dropped, as it always was (browsers fall back to TCP). One the
//! gate lets out directly (the firewall's "allowed, not through the proxy")
//! goes out of this app's own socket, and what comes back is written to the
//! phone as if the site had answered: calls and games keep working for apps
//! that are not sent through the proxy.
//!
//! A flow is the app's address and port and where it sends to. It ends after
//! `IDLE` without a packet either way.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::time::{Duration, Instant};

use tokio::net::UdpSocket;
use tokio::sync::mpsc;

use crate::gate::{Decision, Exits, Flow};
use crate::packet;

/// A flow with nothing sent either way for this long is over.
const IDLE: Duration = Duration::from_secs(120);
/// Packets waiting to go out on one flow; past this, new ones are dropped
/// (UDP allows it, and a flood must not hold the tunnel).
const QUEUED: usize = 64;
/// Flows at once; past this a new one is dropped until old ones end.
const MAX_FLOWS: usize = 2048;
/// How often ended flows are swept away.
const SWEEP_EVERY: Duration = Duration::from_secs(10);
/// The largest datagram read back.
const LARGEST: usize = 65_535;

struct UdpFlow {
    /// The way out, for a flow let out directly; `None` for one dropped.
    out: Option<mpsc::Sender<Vec<u8>>>,
    last: Instant,
}

pub struct UdpFlows {
    flows: HashMap<(SocketAddr, SocketAddr), UdpFlow>,
    to_phone: mpsc::Sender<Vec<u8>>,
    swept: Instant,
}

impl UdpFlows {
    /// Answers go to the phone through `to_phone`.
    pub fn new(to_phone: mpsc::Sender<Vec<u8>>) -> UdpFlows {
        UdpFlows {
            flows: HashMap::new(),
            to_phone,
            swept: Instant::now(),
        }
    }

    /// One UDP packet from the phone. `name` is the stand-in's name when `to`
    /// is one (dns.rs).
    pub fn take(&mut self, from: SocketAddr, to: SocketAddr, payload: &[u8], name: Option<String>, exits: &Exits) {
        let now = Instant::now();
        if now.duration_since(self.swept) >= SWEEP_EVERY {
            self.flows
                .retain(|_, f| now.duration_since(f.last) < IDLE && f.out.as_ref().is_none_or(|tx| !tx.is_closed()));
            self.swept = now;
        }
        let key = (from, to);
        if let Some(f) = self.flows.get_mut(&key) {
            match &f.out {
                Some(tx) if tx.is_closed() => {
                    // Its socket ended (idle, or it failed): a new flow below.
                    self.flows.remove(&key);
                }
                Some(tx) => {
                    f.last = now;
                    let _ = tx.try_send(payload.to_vec());
                    return;
                }
                None => {
                    f.last = now;
                    return;
                }
            }
        }
        if self.flows.len() >= MAX_FLOWS {
            return;
        }
        let decision = exits.gate.decide(&Flow {
            udp: true,
            from,
            to,
            name: name.clone(),
        });
        let out = (decision == Decision::Direct).then(|| {
            let (tx, rx) = mpsc::channel(QUEUED);
            tokio::spawn(forward(from, to, name, rx, self.to_phone.clone()));
            tx
        });
        if let Some(tx) = &out {
            let _ = tx.try_send(payload.to_vec());
        }
        self.flows.insert(key, UdpFlow { out, last: now });
    }
}

/// One flow let out directly, until it is idle or the phone side closes.
async fn forward(
    from: SocketAddr,
    to: SocketAddr,
    name: Option<String>,
    mut rx: mpsc::Receiver<Vec<u8>>,
    to_phone: mpsc::Sender<Vec<u8>>,
) {
    let dest = match name {
        // A stand-in: the name it stands for, looked up with the phone's own DNS.
        Some(n) => match tokio::net::lookup_host((n.as_str(), to.port())).await {
            Ok(mut found) => match found.next() {
                Some(a) => a,
                None => return,
            },
            Err(_) => return,
        },
        None => to,
    };
    let bind: SocketAddr = if dest.is_ipv4() {
        ([0, 0, 0, 0], 0).into()
    } else {
        (std::net::Ipv6Addr::UNSPECIFIED, 0).into()
    };
    let Ok(sock) = UdpSocket::bind(bind).await else { return };
    if sock.connect(dest).await.is_err() {
        return;
    }
    let mut buf = vec![0u8; LARGEST];
    loop {
        tokio::select! {
            p = rx.recv() => match p {
                Some(p) => {
                    let _ = sock.send(&p).await;
                }
                None => return,
            },
            r = sock.recv(&mut buf) => match r {
                // The answer reaches the app from the address it sent to.
                Ok(n) => {
                    if let Some(reply) = packet::udp(to, from, &buf[..n]) {
                        if to_phone.send(reply).await.is_err() {
                            return;
                        }
                    }
                }
                Err(_) => return,
            },
            _ = tokio::time::sleep(IDLE) => return,
        }
    }
}
