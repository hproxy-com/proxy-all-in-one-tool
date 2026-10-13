//! The tunnel's loop: packets from the phone in, packets to the phone out, and
//! in between a TCP/IP stack that turns them into connections.
//!
//! Each turn of the loop:
//!   1. takes the packets the phone sent: a DNS question is answered at once
//!      (dns.rs); the first packet of a new TCP connection is shown to the
//!      gate (gate.rs), and unless the gate blocks it, it gets a socket
//!      listening for it; other UDP goes to its flow (udp.rs), out directly
//!      when the gate says so and dropped otherwise; the rest is dropped;
//!   2. lets the stack read them and answer (handshakes, acknowledgements);
//!   3. moves bytes between each connection and its way out: the relay
//!      (relay.rs) or the site itself (direct.rs), never more than the other
//!      side has room for;
//!   4. sends what the stack wrote back to the phone.
//!
//! It runs again when a packet arrives, when a relay connection has news, or
//! when the stack has a timer due (a retransmission, a closing connection).

use std::collections::{HashMap, VecDeque};
use std::future::Future;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use smoltcp::iface::{Config as IfaceConfig, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{self, Device, DeviceCapabilities, Medium};
use smoltcp::socket::tcp;
use smoltcp::time::Instant as StackInstant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr, IpListenEndpoint};
use tokio::sync::mpsc::error::{TryRecvError, TrySendError};
use tokio::sync::{mpsc, Notify};

use crate::dns::FakeDns;
use crate::gate::{Decision, Exits, Flow};
use crate::packet::{self, Seen};
use crate::relay::{self, FromRelay, Target};
use crate::udp::UdpFlows;
use crate::{MTU, TUN_V4, TUN_V6};

/// How much each connection holds in each direction. Downloads fill the
/// phone-bound side, so it is the bigger one.
const TO_PHONE_BUFFER: usize = 256 * 1024;
const FROM_PHONE_BUFFER: usize = 64 * 1024;
/// How much is read from a connection in one go.
const CHUNK: usize = 16 * 1024;
/// Chunks waiting between a connection and its relay connection.
const IN_FLIGHT: usize = 8;
/// Connections at once; a new one past this is refused (a reset).
const MAX_CONNECTIONS: usize = 4096;
/// A listening socket whose handshake never came is removed after this.
const HANDSHAKE_WITHIN: Duration = Duration::from_secs(10);
/// Packets taken from the phone before the stack runs, so a flood of them
/// never keeps the loop from answering.
const PACKETS_PER_TURN: usize = 256;
/// What the gate said about a connection that never got a socket (a blocked
/// one) is forgotten after this, so a later try is asked again.
const DECIDED_FOR: Duration = Duration::from_secs(30);

/// One connection from the phone.
struct Connection {
    /// When its listening socket was made.
    since: tokio::time::Instant,
    /// Set once the handshake is done and the relay connection is under way.
    bridge: Option<Bridge>,
}

struct Bridge {
    to_relay: Option<mpsc::Sender<Vec<u8>>>,
    from_relay: mpsc::Receiver<FromRelay>,
    /// Bytes from the relay that did not fit yet, and how far they went.
    waiting: Option<(Vec<u8>, usize)>,
    /// The site finished sending.
    relay_done: bool,
    /// The app was told so (FIN).
    told_done: bool,
}

/// The packets the stack reads and writes, kept in memory: the loop moves
/// them to and from the phone.
#[derive(Default)]
struct Queues {
    from_phone: VecDeque<Vec<u8>>,
    to_phone: VecDeque<Vec<u8>>,
}

impl Device for Queues {
    type RxToken<'a> = Rx;
    type TxToken<'a> = Tx<'a>;

    fn capabilities(&self) -> DeviceCapabilities {
        let mut caps = DeviceCapabilities::default();
        caps.medium = Medium::Ip;
        caps.max_transmission_unit = MTU as usize;
        caps
    }

    fn receive(&mut self, _now: StackInstant) -> Option<(Rx, Tx<'_>)> {
        let packet = self.from_phone.pop_front()?;
        Some((Rx(packet), Tx(&mut self.to_phone)))
    }

    fn transmit(&mut self, _now: StackInstant) -> Option<Tx<'_>> {
        Some(Tx(&mut self.to_phone))
    }
}

struct Rx(Vec<u8>);

impl phy::RxToken for Rx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}

struct Tx<'a>(&'a mut VecDeque<Vec<u8>>);

impl phy::TxToken for Tx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut packet = vec![0u8; len];
        let r = f(&mut packet);
        self.0.push_back(packet);
        r
    }
}

/// Runs the tunnel until `stop` finishes or the phone side closes, every
/// connection through the relay on `relay`. `from_phone` and `to_phone`
/// carry whole IP packets.
pub async fn run(
    from_phone: mpsc::Receiver<Vec<u8>>,
    to_phone: mpsc::Sender<Vec<u8>>,
    relay: SocketAddr,
    stop: impl Future<Output = ()>,
) {
    run_with(from_phone, to_phone, Exits::through(relay), stop).await
}

/// `run`, with a gate that decides the way out of every new connection.
pub async fn run_with(
    mut from_phone: mpsc::Receiver<Vec<u8>>,
    to_phone: mpsc::Sender<Vec<u8>>,
    exits: Exits,
    stop: impl Future<Output = ()>,
) {
    let mut t = Tunnel::new(exits, to_phone.clone());
    tokio::pin!(stop);
    loop {
        let delay = t.next_timer();
        tokio::select! {
            biased;
            _ = &mut stop => break,
            packet = from_phone.recv() => match packet {
                Some(p) => t.take(p),
                None => break,
            },
            _ = t.wake.notified() => {}
            _ = tokio::time::sleep(delay) => {}
        }
        for _ in 1..PACKETS_PER_TURN {
            match from_phone.try_recv() {
                Ok(p) => t.take(p),
                Err(_) => break,
            }
        }
        t.turn();
        while let Some(p) = t.queues.to_phone.pop_front() {
            if to_phone.send(p).await.is_err() {
                return;
            }
        }
    }
}

struct Tunnel {
    exits: Exits,
    iface: Interface,
    sockets: SocketSet<'static>,
    queues: Queues,
    connections: HashMap<SocketHandle, Connection>,
    /// The connection each (app address, site address) pair is, once its
    /// handshake started: a repeated first packet must not open a second one.
    by_pair: HashMap<(SocketAddr, SocketAddr), SocketHandle>,
    /// What the gate said about each connection, by (app address, site
    /// address), from its first packet until its socket is gone.
    decided: HashMap<(SocketAddr, SocketAddr), (Decision, tokio::time::Instant)>,
    udp: UdpFlows,
    dns: FakeDns,
    wake: Arc<Notify>,
    started: tokio::time::Instant,
}

impl Tunnel {
    fn new(exits: Exits, to_phone: mpsc::Sender<Vec<u8>>) -> Tunnel {
        let mut queues = Queues::default();
        let started = tokio::time::Instant::now();
        let mut iface = Interface::new(
            IfaceConfig::new(HardwareAddress::Ip),
            &mut queues,
            StackInstant::from_millis(0),
        );
        // Take connections to every address: each one stands for a site.
        iface.set_any_ip(true);
        iface.update_ip_addrs(|addrs| {
            let _ = addrs.push(IpCidr::new(IpAddress::Ipv4(TUN_V4), 32));
            let _ = addrs.push(IpCidr::new(IpAddress::Ipv6(TUN_V6), 128));
        });
        let _ = iface.routes_mut().add_default_ipv4_route(TUN_V4);
        let _ = iface.routes_mut().add_default_ipv6_route(TUN_V6);
        Tunnel {
            exits,
            iface,
            sockets: SocketSet::new(Vec::new()),
            queues,
            connections: HashMap::new(),
            by_pair: HashMap::new(),
            decided: HashMap::new(),
            udp: UdpFlows::new(to_phone),
            dns: FakeDns::default(),
            wake: Arc::new(Notify::new()),
            started,
        }
    }

    fn now(&self) -> StackInstant {
        StackInstant::from_millis(self.started.elapsed().as_millis() as i64)
    }

    /// When the stack next has something to do on its own.
    fn next_timer(&mut self) -> Duration {
        let now = self.now();
        match self.iface.poll_delay(now, &self.sockets) {
            Some(d) => Duration::from_micros(d.total_micros()).min(Duration::from_secs(1)),
            None => Duration::from_secs(1),
        }
    }

    /// One packet from the phone.
    fn take(&mut self, packet: Vec<u8>) {
        match packet::read(&packet) {
            Seen::Udp { from, to, payload } if to.port() == 53 => {
                // Any DNS server the app asks, the answer comes from here, from
                // the address it asked.
                if let Some(answer) = self.dns.answer(payload) {
                    if let Some(reply) = packet::udp(to, from, &answer) {
                        self.queues.to_phone.push_back(reply);
                    }
                }
            }
            Seen::Tcp { from, to, opens } => {
                if opens
                    && !self.by_pair.contains_key(&(from, to))
                    && !self.refused(to)
                    && self.decide(from, to) != Decision::Block
                {
                    self.listen(to);
                }
                // A blocked connection reaches the stack with nobody
                // listening, and the stack answers it with a reset.
                self.queues.from_phone.push_back(packet);
            }
            // Other UDP: out directly when the gate lets it, dropped otherwise
            // (an HTTP proxy cannot carry it).
            Seen::Udp { from, to, payload } => {
                let name = self.stand_in_name(to);
                self.udp.take(from, to, payload, name, &self.exits);
            }
            // Pings would only say what this phone answers: they never leave.
            Seen::Other => {}
        }
    }

    /// The name behind a stand-in address, when `to` is one.
    fn stand_in_name(&self, to: SocketAddr) -> Option<String> {
        match to.ip() {
            IpAddr::V4(ip) if crate::is_stand_in(ip) => self.dns.name_of(ip).map(str::to_string),
            _ => None,
        }
    }

    /// The gate's word on a new connection, asked once: a repeated first
    /// packet (the app trying again before the answer came) gets the same.
    fn decide(&mut self, from: SocketAddr, to: SocketAddr) -> Decision {
        let now = tokio::time::Instant::now();
        if self.decided.len() > MAX_CONNECTIONS {
            self.decided.retain(|_, (_, at)| now.duration_since(*at) < DECIDED_FOR);
        }
        if let Some((d, at)) = self.decided.get(&(from, to)) {
            if now.duration_since(*at) < DECIDED_FOR {
                return *d;
            }
        }
        let name = self.stand_in_name(to);
        let d = self.exits.gate.decide(&Flow {
            udp: false,
            from,
            to,
            name,
        });
        self.decided.insert((from, to), (d, now));
        d
    }

    /// A connection the tunnel will not open: to the stand-in DNS server
    /// (encrypted DNS falls back to the plain kind, answered here), or past
    /// the limit. With no socket listening, the stack answers with a reset.
    fn refused(&self, to: SocketAddr) -> bool {
        to.ip() == IpAddr::V4(crate::DNS_V4) || self.connections.len() >= MAX_CONNECTIONS
    }

    /// A socket listening for the connection the phone is opening to `to`.
    fn listen(&mut self, to: SocketAddr) {
        let mut socket = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; FROM_PHONE_BUFFER]),
            tcp::SocketBuffer::new(vec![0; TO_PHONE_BUFFER]),
        );
        socket.set_nagle_enabled(false);
        let endpoint = IpListenEndpoint {
            addr: Some(IpAddress::from(to.ip())),
            port: to.port(),
        };
        if socket.listen(endpoint).is_err() {
            return; // port 0: no connection to make
        }
        let handle = self.sockets.add(socket);
        self.connections.insert(
            handle,
            Connection {
                since: tokio::time::Instant::now(),
                bridge: None,
            },
        );
    }

    /// The stack runs, the connections move their bytes, the stack runs again
    /// to send what they wrote.
    fn turn(&mut self) {
        let now = self.now();
        self.iface.poll(now, &mut self.queues, &mut self.sockets);
        let handles: Vec<SocketHandle> = self.connections.keys().copied().collect();
        for handle in handles {
            self.serve(handle);
        }
        let now = self.now();
        self.iface.poll(now, &mut self.queues, &mut self.sockets);
    }

    fn serve(&mut self, handle: SocketHandle) {
        let socket = self.sockets.get_mut::<tcp::Socket>(handle);
        let state = socket.state();
        let pair = match (socket.remote_endpoint(), socket.local_endpoint()) {
            (Some(r), Some(l)) => Some((to_socket_addr(r), to_socket_addr(l))),
            _ => None,
        };
        let Some(conn) = self.connections.get_mut(&handle) else {
            return;
        };

        if state == tcp::State::Closed || (state == tcp::State::Listen && conn.since.elapsed() > HANDSHAKE_WITHIN) {
            self.sockets.remove(handle);
            self.connections.remove(&handle);
            let mut gone = Vec::new();
            self.by_pair.retain(|pair, h| {
                if *h == handle {
                    gone.push(*pair);
                }
                *h != handle
            });
            for pair in gone {
                self.decided.remove(&pair);
            }
            return;
        }
        if let Some(pair) = pair {
            self.by_pair.entry(pair).or_insert(handle);
        }

        // The handshake is done: open the relay connection.
        if conn.bridge.is_none() && matches!(state, tcp::State::Established | tcp::State::CloseWait) {
            let Some((remote, local)) = pair else { return };
            let target = match local.ip() {
                IpAddr::V4(ip) if crate::is_stand_in(ip) => match self.dns.name_of(ip) {
                    Some(name) => Target::Name(name.to_string(), local.port()),
                    // A stand-in nobody was given (the app kept it too long, or
                    // guessed it): nowhere to go.
                    None => {
                        socket.abort();
                        return;
                    }
                },
                _ => Target::Address(local),
            };
            let decision = self.decided.get(&(remote, local)).map_or(Decision::Proxy, |(d, _)| *d);
            let (to_relay, relay_in) = mpsc::channel(IN_FLIGHT);
            let (relay_out, from_relay) = mpsc::channel(IN_FLIGHT);
            match (decision, self.exits.relay) {
                (Decision::Proxy, Some(relay)) => {
                    tokio::spawn(relay::carry(relay, target, relay_in, relay_out, self.wake.clone()));
                }
                (Decision::Direct, _) => {
                    tokio::spawn(crate::direct::carry(target, relay_in, relay_out, self.wake.clone()));
                }
                // Meant for the proxy while none is connected, or blocked: the
                // app is told at once, and nothing goes around the proxy.
                (Decision::Proxy, None) | (Decision::Block, _) => {
                    socket.abort();
                    return;
                }
            }
            conn.bridge = Some(Bridge {
                to_relay: Some(to_relay),
                from_relay,
                waiting: None,
                relay_done: false,
                told_done: false,
            });
        }
        let Some(b) = conn.bridge.as_mut() else { return };

        // From the app to the relay, while the relay side has room.
        if let Some(tx) = &b.to_relay {
            let mut gone = false;
            while socket.can_recv() {
                match tx.try_reserve() {
                    Ok(permit) => {
                        let mut chunk = vec![0u8; socket.recv_queue().min(CHUNK)];
                        let n = socket.recv_slice(&mut chunk).unwrap_or(0);
                        chunk.truncate(n);
                        permit.send(chunk);
                    }
                    Err(TrySendError::Full(())) => break,
                    Err(TrySendError::Closed(())) => {
                        gone = true;
                        break;
                    }
                }
            }
            // The relay side is gone, or the app finished sending and
            // everything it sent went on.
            if gone || (!socket.may_recv() && !socket.can_recv()) {
                b.to_relay = None;
            }
        }

        // From the relay to the app, while the app's side has room.
        loop {
            if let Some((data, sent)) = b.waiting.as_mut() {
                if !socket.can_send() {
                    break;
                }
                *sent += socket.send_slice(&data[*sent..]).unwrap_or(0);
                if *sent < data.len() {
                    break;
                }
                b.waiting = None;
            }
            match b.from_relay.try_recv() {
                Ok(FromRelay::Data(data)) => b.waiting = Some((data, 0)),
                Ok(FromRelay::Failed) => {
                    socket.abort();
                    return;
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    b.relay_done = true;
                    break;
                }
            }
        }
        if b.relay_done && b.waiting.is_none() && !b.told_done {
            socket.close();
            b.told_done = true;
        }
    }
}

fn to_socket_addr(e: smoltcp::wire::IpEndpoint) -> SocketAddr {
    SocketAddr::new(IpAddr::from(e.addr), e.port)
}
