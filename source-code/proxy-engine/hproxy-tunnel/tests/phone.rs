//! A phone, played by a second TCP/IP stack, sends its packets through the
//! tunnel; a small SOCKS5 server stands in for the relay and says what it was
//! asked for. Everything runs in memory and on 127.0.0.1.

use std::net::{Ipv4Addr, SocketAddr};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use hproxy_tunnel::packet::{self, Seen};
use smoltcp::iface::{Config, Interface, SocketHandle, SocketSet};
use smoltcp::phy::{self, Device, DeviceCapabilities, Medium};
use smoltcp::socket::tcp;
use smoltcp::time::Instant as StackInstant;
use smoltcp::wire::{HardwareAddress, IpAddress, IpCidr};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::{mpsc, oneshot};

const PHONE: Ipv4Addr = Ipv4Addr::new(10, 0, 0, 2);
const PHONE_V6: std::net::Ipv6Addr = std::net::Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 2);

/// The stand-in relay: answers SOCKS5, writes down every target it was asked
/// for, and connects them all to `site`.
async fn pretend_relay(site: SocketAddr) -> (SocketAddr, Arc<Mutex<Vec<String>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let asked = Arc::new(Mutex::new(Vec::new()));
    let log = asked.clone();
    tokio::spawn(async move {
        loop {
            let (mut c, _) = listener.accept().await.unwrap();
            let log = log.clone();
            tokio::spawn(async move {
                let mut hello = [0u8; 3];
                c.read_exact(&mut hello).await.unwrap();
                c.write_all(&[5, 0]).await.unwrap();
                let mut head = [0u8; 4];
                c.read_exact(&mut head).await.unwrap();
                let target = match head[3] {
                    3 => {
                        let mut len = [0u8; 1];
                        c.read_exact(&mut len).await.unwrap();
                        let mut name = vec![0u8; len[0] as usize];
                        c.read_exact(&mut name).await.unwrap();
                        String::from_utf8(name).unwrap()
                    }
                    1 => {
                        let mut ip = [0u8; 4];
                        c.read_exact(&mut ip).await.unwrap();
                        Ipv4Addr::from(ip).to_string()
                    }
                    4 => {
                        let mut ip = [0u8; 16];
                        c.read_exact(&mut ip).await.unwrap();
                        format!("[{}]", std::net::Ipv6Addr::from(ip))
                    }
                    _ => panic!("unexpected address type"),
                };
                let mut port = [0u8; 2];
                c.read_exact(&mut port).await.unwrap();
                log.lock()
                    .unwrap()
                    .push(format!("{target}:{}", u16::from_be_bytes(port)));
                let mut up = TcpStream::connect(site).await.unwrap();
                c.write_all(&[5, 0, 0, 1, 0, 0, 0, 0, 0, 0]).await.unwrap();
                let _ = tokio::io::copy_bidirectional(&mut c, &mut up).await;
            });
        }
    });
    (addr, asked)
}

/// A site that counts what it is sent until the sender is done, then says the
/// number and closes.
async fn counting_site() -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut c, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut all = Vec::new();
                c.read_to_end(&mut all).await.unwrap();
                let ok = all.iter().enumerate().all(|(i, &b)| b == (i % 253) as u8);
                c.write_all(format!("{} {}\n", all.len(), if ok { "in order" } else { "broken" }).as_bytes())
                    .await
                    .unwrap();
            });
        }
    });
    addr
}

/// The site: reads one line, answers with it and then `extra` bytes, then closes.
async fn site(extra: usize) -> SocketAddr {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move {
        loop {
            let (mut c, _) = listener.accept().await.unwrap();
            tokio::spawn(async move {
                let mut got = Vec::new();
                let mut b = [0u8; 1];
                while c.read_exact(&mut b).await.is_ok() && b[0] != b'\n' {
                    got.push(b[0]);
                }
                let mut answer = b"you said ".to_vec();
                answer.extend_from_slice(&got);
                answer.push(b'\n');
                answer.extend((0..extra).map(|i| (i % 251) as u8));
                c.write_all(&answer).await.unwrap();
            });
        }
    });
    addr
}

/// The phone's side of the wire, in memory.
#[derive(Default)]
struct Wire {
    rx: std::collections::VecDeque<Vec<u8>>,
    tx: std::collections::VecDeque<Vec<u8>>,
}
struct Rx(Vec<u8>);
struct Tx<'a>(&'a mut std::collections::VecDeque<Vec<u8>>);
impl phy::RxToken for Rx {
    fn consume<R, F: FnOnce(&[u8]) -> R>(self, f: F) -> R {
        f(&self.0)
    }
}
impl phy::TxToken for Tx<'_> {
    fn consume<R, F: FnOnce(&mut [u8]) -> R>(self, len: usize, f: F) -> R {
        let mut p = vec![0u8; len];
        let r = f(&mut p);
        self.0.push_back(p);
        r
    }
}
impl Device for Wire {
    type RxToken<'a> = Rx;
    type TxToken<'a> = Tx<'a>;
    fn capabilities(&self) -> DeviceCapabilities {
        let mut c = DeviceCapabilities::default();
        c.medium = Medium::Ip;
        c.max_transmission_unit = 1500;
        c
    }
    fn receive(&mut self, _: StackInstant) -> Option<(Rx, Tx<'_>)> {
        let p = self.rx.pop_front()?;
        Some((Rx(p), Tx(&mut self.tx)))
    }
    fn transmit(&mut self, _: StackInstant) -> Option<Tx<'_>> {
        Some(Tx(&mut self.tx))
    }
}

/// A phone with its own TCP/IP stack, wired to a running tunnel.
struct Phone {
    iface: Interface,
    sockets: SocketSet<'static>,
    wire: Wire,
    to_tunnel: mpsc::Sender<Vec<u8>>,
    from_tunnel: mpsc::Receiver<Vec<u8>>,
    started: std::time::Instant,
    _stop: oneshot::Sender<()>,
}

impl Phone {
    fn start(relay: SocketAddr) -> Phone {
        Phone::start_with(hproxy_tunnel::Exits::through(relay))
    }

    fn start_with(exits: hproxy_tunnel::Exits) -> Phone {
        let (to_tunnel, tunnel_in) = mpsc::channel(1024);
        let (tunnel_out, from_tunnel) = mpsc::channel(1024);
        let (stop_tx, stop_rx) = oneshot::channel::<()>();
        tokio::spawn(hproxy_tunnel::run_with(tunnel_in, tunnel_out, exits, async {
            let _ = stop_rx.await;
        }));
        let mut wire = Wire::default();
        let mut iface = Interface::new(
            Config::new(HardwareAddress::Ip),
            &mut wire,
            StackInstant::from_millis(0),
        );
        iface.update_ip_addrs(|a| {
            let _ = a.push(IpCidr::new(IpAddress::Ipv4(PHONE), 24));
            let _ = a.push(IpCidr::new(IpAddress::Ipv6(PHONE_V6), 64));
        });
        iface
            .routes_mut()
            .add_default_ipv4_route(Ipv4Addr::new(10, 0, 0, 1))
            .unwrap();
        iface
            .routes_mut()
            .add_default_ipv6_route(std::net::Ipv6Addr::new(0xfd00, 0, 0, 0, 0, 0, 0, 1))
            .unwrap();
        Phone {
            iface,
            sockets: SocketSet::new(Vec::new()),
            wire,
            to_tunnel,
            from_tunnel,
            started: std::time::Instant::now(),
            _stop: stop_tx,
        }
    }

    /// One step: the phone's stack runs, its packets go to the tunnel, the
    /// tunnel's come back.
    async fn step(&mut self) {
        let now = StackInstant::from_millis(self.started.elapsed().as_millis() as i64);
        self.iface.poll(now, &mut self.wire, &mut self.sockets);
        while let Some(p) = self.wire.tx.pop_front() {
            self.to_tunnel.send(p).await.unwrap();
        }
        tokio::time::sleep(Duration::from_millis(1)).await;
        while let Ok(p) = self.from_tunnel.try_recv() {
            self.wire.rx.push_back(p);
        }
    }

    /// Asks the tunnel's DNS for a name, the way an app does, and returns the address.
    async fn look_up(&mut self, name: &str) -> Ipv4Addr {
        let mut q = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in name.split('.') {
            q.push(label.len() as u8);
            q.extend_from_slice(label.as_bytes());
        }
        q.extend_from_slice(&[0, 0, 1, 0, 1]);
        let from = SocketAddr::new(PHONE.into(), 40000);
        let server: SocketAddr = "8.8.8.8:53".parse().unwrap();
        self.to_tunnel
            .send(packet::udp(from, server, &q).unwrap())
            .await
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(5), self.from_tunnel.recv())
            .await
            .unwrap()
            .unwrap();
        match packet::read(&reply) {
            Seen::Udp { from: f, to, payload } => {
                assert_eq!((f, to), (server, from), "the answer comes from the server asked");
                let ip = &payload[payload.len() - 4..];
                Ipv4Addr::new(ip[0], ip[1], ip[2], ip[3])
            }
            other => panic!("not a DNS answer: {other:?}"),
        }
    }

    fn open(&mut self, to: SocketAddr, port: u16) -> SocketHandle {
        let mut s = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; 256 * 1024]),
            tcp::SocketBuffer::new(vec![0; 64 * 1024]),
        );
        s.connect(self.iface.context(), (IpAddress::from(to.ip()), to.port()), port)
            .unwrap();
        self.sockets.add(s)
    }

    /// Sends `line`, then reads until the site closes. `Err` when the tunnel
    /// reset the connection.
    async fn exchange(&mut self, h: SocketHandle, line: &[u8]) -> Result<Vec<u8>, tcp::State> {
        let mut sent = false;
        let mut got = Vec::new();
        let deadline = std::time::Instant::now() + Duration::from_secs(20);
        loop {
            assert!(
                std::time::Instant::now() < deadline,
                "timed out with {} bytes",
                got.len()
            );
            self.step().await;
            let s = self.sockets.get_mut::<tcp::Socket>(h);
            if !sent && s.may_send() {
                s.send_slice(line).unwrap();
                sent = true;
            }
            while s.can_recv() {
                s.recv(|b| {
                    got.extend_from_slice(b);
                    (b.len(), ())
                })
                .unwrap();
            }
            if sent && !s.may_recv() && !got.is_empty() {
                s.close();
                return Ok(got);
            }
            if s.state() == tcp::State::Closed {
                return Err(tcp::State::Closed);
            }
        }
    }
}

#[tokio::test]
async fn a_lookup_and_a_connection_reach_the_site_by_name() {
    let site = site(0).await;
    let (relay, asked) = pretend_relay(site).await;
    let mut phone = Phone::start(relay);

    let ip = phone.look_up("www.example.com").await;
    assert!(hproxy_tunnel::is_stand_in(ip), "{ip} is a stand-in");
    let h = phone.open(SocketAddr::new(ip.into(), 443), 50000);
    let got = phone.exchange(h, b"hello\n").await.unwrap();

    assert_eq!(got, b"you said hello\n");
    assert_eq!(
        asked.lock().unwrap().as_slice(),
        ["www.example.com:443"],
        "the relay was asked for the NAME, never an address"
    );
}

#[tokio::test]
async fn two_megabytes_come_down_whole() {
    let size = 2 * 1024 * 1024;
    let site = site(size).await;
    let (relay, _) = pretend_relay(site).await;
    let mut phone = Phone::start(relay);

    let ip = phone.look_up("download.example").await;
    let h = phone.open(SocketAddr::new(ip.into(), 80), 50001);
    let got = phone.exchange(h, b"big\n").await.unwrap();

    let head = b"you said big\n".len();
    assert_eq!(got.len(), head + size);
    assert!(
        got[head..].iter().enumerate().all(|(i, &b)| b == (i % 251) as u8),
        "every byte in order"
    );
}

#[tokio::test]
async fn an_address_without_a_name_goes_to_the_relay_as_an_address() {
    let site = site(0).await;
    let (relay, asked) = pretend_relay(site).await;
    let mut phone = Phone::start(relay);

    let h = phone.open("93.184.216.34:8080".parse().unwrap(), 50002);
    phone.exchange(h, b"hi\n").await.unwrap();
    assert_eq!(asked.lock().unwrap().as_slice(), ["93.184.216.34:8080"]);
}

#[tokio::test]
async fn several_connections_at_once_each_reach_their_own_site() {
    let site = site(0).await;
    let (relay, asked) = pretend_relay(site).await;
    let mut phone = Phone::start(relay);

    let mut handles = Vec::new();
    for (i, name) in ["a.example", "b.example", "c.example"].iter().enumerate() {
        let ip = phone.look_up(name).await;
        handles.push(phone.open(SocketAddr::new(ip.into(), 443), 51000 + i as u16));
    }
    for h in handles {
        assert_eq!(phone.exchange(h, b"x\n").await.unwrap(), b"you said x\n");
    }
    let mut seen = asked.lock().unwrap().clone();
    seen.sort();
    assert_eq!(seen, ["a.example:443", "b.example:443", "c.example:443"]);
}

#[tokio::test]
async fn an_ipv6_address_goes_through_too() {
    let site = site(0).await;
    let (relay, asked) = pretend_relay(site).await;
    let mut phone = Phone::start(relay);

    let h = phone.open("[2001:db8::7]:443".parse().unwrap(), 50005);
    assert_eq!(phone.exchange(h, b"six\n").await.unwrap(), b"you said six\n");
    assert_eq!(asked.lock().unwrap().as_slice(), ["[2001:db8::7]:443"]);
}

#[tokio::test]
async fn a_megabyte_goes_up_whole_and_the_app_can_say_it_is_done() {
    let (relay, _) = pretend_relay(counting_site().await).await;
    let mut phone = Phone::start(relay);
    let ip = phone.look_up("upload.example").await;
    let h = phone.open(SocketAddr::new(ip.into(), 443), 50006);

    let size = 1024 * 1024;
    let body: Vec<u8> = (0..size).map(|i| (i % 253) as u8).collect();
    let mut sent = 0;
    let mut got = Vec::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(20);
    loop {
        assert!(std::time::Instant::now() < deadline, "timed out after sending {sent}");
        phone.step().await;
        let s = phone.sockets.get_mut::<tcp::Socket>(h);
        if sent < size && s.can_send() {
            sent += s.send_slice(&body[sent..]).unwrap();
            if sent == size {
                s.close(); // done sending: the site sees the end
            }
        }
        while s.can_recv() {
            s.recv(|b| {
                got.extend_from_slice(b);
                (b.len(), ())
            })
            .unwrap();
        }
        if !s.may_recv() && !got.is_empty() {
            break;
        }
    }
    assert_eq!(String::from_utf8(got).unwrap(), format!("{size} in order\n"));
}

#[tokio::test]
async fn a_relay_that_is_down_resets_the_app_at_once() {
    // Nothing listens here: the relay is not running.
    let closed = TcpListener::bind("127.0.0.1:0").await.unwrap().local_addr().unwrap();
    let mut phone = Phone::start(closed);
    let ip = phone.look_up("example.com").await;
    let h = phone.open(SocketAddr::new(ip.into(), 443), 50003);
    assert_eq!(phone.exchange(h, b"hello\n").await, Err(tcp::State::Closed));
}

#[tokio::test]
async fn a_stand_in_nobody_was_given_is_refused() {
    let site = site(0).await;
    let (relay, asked) = pretend_relay(site).await;
    let mut phone = Phone::start(relay);
    let h = phone.open("198.18.9.9:443".parse().unwrap(), 50004);
    assert_eq!(phone.exchange(h, b"hello\n").await, Err(tcp::State::Closed));
    assert!(asked.lock().unwrap().is_empty(), "nothing went to the relay");
}

#[tokio::test]
async fn udp_other_than_dns_never_comes_back() {
    let (relay, _) = pretend_relay(site(0).await).await;
    let mut phone = Phone::start(relay);
    let from = SocketAddr::new(PHONE.into(), 40001);
    phone
        .to_tunnel
        .send(packet::udp(from, "1.1.1.1:443".parse().unwrap(), b"quic").unwrap())
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(300), phone.from_tunnel.recv())
            .await
            .is_err(),
        "no answer, nothing sent"
    );
}

/// A gate that answers every flow the same, and writes down what it was asked.
struct Always(hproxy_tunnel::Decision, Arc<Mutex<Vec<hproxy_tunnel::Flow>>>);

impl hproxy_tunnel::Gate for Always {
    fn decide(&self, flow: &hproxy_tunnel::Flow) -> hproxy_tunnel::Decision {
        self.1.lock().unwrap().push(flow.clone());
        self.0
    }
}

fn exits(
    relay: Option<SocketAddr>,
    decision: hproxy_tunnel::Decision,
) -> (hproxy_tunnel::Exits, Arc<Mutex<Vec<hproxy_tunnel::Flow>>>) {
    let asked = Arc::new(Mutex::new(Vec::new()));
    (
        hproxy_tunnel::Exits {
            relay,
            gate: Arc::new(Always(decision, asked.clone())),
        },
        asked,
    )
}

#[tokio::test]
async fn a_blocked_app_is_reset_at_once_and_nothing_reaches_the_relay() {
    let (relay, relayed) = pretend_relay(site(0).await).await;
    let (exits, flows) = exits(Some(relay), hproxy_tunnel::Decision::Block);
    let mut phone = Phone::start_with(exits);
    let ip = phone.look_up("blocked.example").await;
    let h = phone.open(SocketAddr::new(ip.into(), 443), 50100);
    assert_eq!(phone.exchange(h, b"hello\n").await, Err(tcp::State::Closed));
    assert!(relayed.lock().unwrap().is_empty(), "nothing went to the relay");
    let flows = flows.lock().unwrap();
    assert_eq!(flows.len(), 1, "the gate is asked once per connection: {flows:?}");
    assert_eq!(
        flows[0].name.as_deref(),
        Some("blocked.example"),
        "and told the name behind the stand-in"
    );
    assert!(!flows[0].udp);
}

#[tokio::test]
async fn an_app_let_out_directly_reaches_the_site_itself() {
    let site = site(0).await;
    let (relay, relayed) = pretend_relay(site).await;
    let (exits, _) = exits(Some(relay), hproxy_tunnel::Decision::Direct);
    let mut phone = Phone::start_with(exits);
    let h = phone.open(site, 50101);
    assert_eq!(phone.exchange(h, b"direct\n").await.unwrap(), b"you said direct\n");
    let ip = phone.look_up("localhost").await;
    let h = phone.open(SocketAddr::new(ip.into(), site.port()), 50102);
    assert_eq!(
        phone.exchange(h, b"by name\n").await.unwrap(),
        b"you said by name\n",
        "a name is looked up here"
    );
    assert!(relayed.lock().unwrap().is_empty(), "the relay never saw it");
}

#[tokio::test]
async fn without_a_relay_a_connection_meant_for_the_proxy_is_reset() {
    let (exits, _) = exits(None, hproxy_tunnel::Decision::Proxy);
    let mut phone = Phone::start_with(exits);
    let ip = phone.look_up("example.com").await;
    let h = phone.open(SocketAddr::new(ip.into(), 443), 50103);
    assert_eq!(
        phone.exchange(h, b"hello\n").await,
        Err(tcp::State::Closed),
        "never sent around the proxy"
    );
}

#[tokio::test]
async fn udp_let_out_directly_comes_back_from_where_it_went() {
    let echo = tokio::net::UdpSocket::bind("127.0.0.1:0").await.unwrap();
    let echo_at = echo.local_addr().unwrap();
    tokio::spawn(async move {
        let mut buf = [0u8; 1500];
        loop {
            let (n, from) = echo.recv_from(&mut buf).await.unwrap();
            let mut answer = b"echo ".to_vec();
            answer.extend_from_slice(&buf[..n]);
            echo.send_to(&answer, from).await.unwrap();
        }
    });
    let (exits, flows) = exits(None, hproxy_tunnel::Decision::Direct);
    let mut phone = Phone::start_with(exits);
    let from = SocketAddr::new(PHONE.into(), 40100);
    for word in [&b"one"[..], &b"two"[..]] {
        phone
            .to_tunnel
            .send(packet::udp(from, echo_at, word).unwrap())
            .await
            .unwrap();
        let reply = tokio::time::timeout(Duration::from_secs(5), phone.from_tunnel.recv())
            .await
            .unwrap()
            .unwrap();
        match packet::read(&reply) {
            Seen::Udp { from: f, to, payload } => {
                assert_eq!((f, to), (echo_at, from), "the answer comes from where the app sent it");
                let mut want = b"echo ".to_vec();
                want.extend_from_slice(word);
                assert_eq!(payload, &want[..]);
            }
            other => panic!("not a UDP answer: {other:?}"),
        }
    }
    let flows = flows.lock().unwrap();
    assert_eq!(flows.len(), 1, "one flow, asked about once: {flows:?}");
    assert!(flows[0].udp);
}

#[tokio::test]
async fn udp_meant_for_the_proxy_is_still_dropped() {
    let (relay, _) = pretend_relay(site(0).await).await;
    let (exits, _) = exits(Some(relay), hproxy_tunnel::Decision::Proxy);
    let mut phone = Phone::start_with(exits);
    let from = SocketAddr::new(PHONE.into(), 40101);
    phone
        .to_tunnel
        .send(packet::udp(from, "127.0.0.1:9".parse().unwrap(), b"quic").unwrap())
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_millis(300), phone.from_tunnel.recv())
            .await
            .is_err()
    );
}
