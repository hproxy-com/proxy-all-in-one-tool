//! One connection from the phone, carried by the relay: a SOCKS5 CONNECT to
//! 127.0.0.1, by name when the app looked one up, by address otherwise. The
//! relay adds the login, picks the exit (Next IP, groups, switching) and counts
//! the bytes, exactly as for a program on a computer.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};

/// Where an app wants to go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    Name(String, u16),
    Address(SocketAddr),
}

/// What the relay side sends back into the tunnel.
#[derive(Debug)]
pub enum FromRelay {
    Data(Vec<u8>),
    /// The relay could not connect, or the connection broke: the app is told
    /// at once (a reset), never left waiting.
    Failed,
}

/// Bytes read from the relay in one go.
const CHUNK: usize = 16 * 1024;
/// The relay is on this phone; it answers at once or not at all.
const RELAY_ANSWERS_WITHIN: Duration = Duration::from_secs(30);

/// Carries one connection through the relay until both sides are done.
/// `to_relay` closing means the app finished sending; `from_relay` closing
/// (with no `Failed`) means the site finished. `wake` is rung after every
/// step, so the tunnel looks again.
pub async fn carry(
    relay: SocketAddr,
    target: Target,
    to_relay: mpsc::Receiver<Vec<u8>>,
    from_relay: mpsc::Sender<FromRelay>,
    wake: Arc<Notify>,
) {
    let opening = open(relay, &target);
    bridge(opening, &target, RELAY_ANSWERS_WITHIN, to_relay, from_relay, wake).await
}

/// Carries one connection over whatever `opening` connects to: the relay, or
/// the site itself (direct.rs). The same moving of bytes either way.
pub(crate) async fn bridge<F>(
    opening: F,
    target: &Target,
    within: Duration,
    mut to_relay: mpsc::Receiver<Vec<u8>>,
    from_relay: mpsc::Sender<FromRelay>,
    wake: Arc<Notify>,
) where
    F: std::future::Future<Output = io::Result<TcpStream>>,
{
    let stream = match tokio::time::timeout(within, opening).await {
        Ok(Ok(s)) => s,
        Ok(Err(e)) => {
            log::debug!("tunnel: {target:?} could not be reached: {e}");
            let _ = from_relay.send(FromRelay::Failed).await;
            wake.notify_one();
            return;
        }
        Err(_) => {
            log::debug!("tunnel: {target:?}: no answer in time");
            let _ = from_relay.send(FromRelay::Failed).await;
            wake.notify_one();
            return;
        }
    };
    let (mut rd, mut wr) = stream.into_split();
    let up_wake = wake.clone();
    let up = async move {
        while let Some(chunk) = to_relay.recv().await {
            up_wake.notify_one(); // room for more from the app
            if wr.write_all(&chunk).await.is_err() {
                return;
            }
        }
        let _ = wr.shutdown().await;
    };
    let down_wake = wake.clone();
    let down = async move {
        let mut buf = vec![0u8; CHUNK];
        loop {
            match rd.read(&mut buf).await {
                Ok(0) => break,
                Ok(n) => {
                    if from_relay.send(FromRelay::Data(buf[..n].to_vec())).await.is_err() {
                        break;
                    }
                }
                Err(_) => {
                    let _ = from_relay.send(FromRelay::Failed).await;
                    break;
                }
            }
            down_wake.notify_one();
        }
        // Dropping `from_relay` here tells the tunnel the site is done.
    };
    tokio::join!(up, down);
    wake.notify_one();
}

/// A connection through the relay's SOCKS5 side, with no login (the relay
/// listens on this phone only).
pub async fn open(relay: SocketAddr, target: &Target) -> io::Result<TcpStream> {
    let mut s = TcpStream::connect(relay).await?;
    s.set_nodelay(true)?;
    s.write_all(&[5, 1, 0]).await?;
    let mut hello = [0u8; 2];
    s.read_exact(&mut hello).await?;
    if hello != [5, 0] {
        return Err(io::Error::other("the relay did not accept a SOCKS5 greeting"));
    }
    s.write_all(&request(target)?).await?;
    let mut head = [0u8; 4];
    s.read_exact(&mut head).await?;
    if head[0] != 5 {
        return Err(io::Error::other("the relay answered something other than SOCKS5"));
    }
    // The bound address that follows says nothing useful: read past it.
    let rest = match head[3] {
        1 => 4 + 2,
        4 => 16 + 2,
        3 => {
            let mut len = [0u8; 1];
            s.read_exact(&mut len).await?;
            len[0] as usize + 2
        }
        _ => return Err(io::Error::other("the relay's answer could not be read")),
    };
    let mut skip = vec![0u8; rest];
    s.read_exact(&mut skip).await?;
    if head[1] != 0 {
        return Err(io::Error::other(format!(
            "the relay refused the connection (SOCKS5 code {})",
            head[1]
        )));
    }
    Ok(s)
}

/// The CONNECT request for a target.
fn request(target: &Target) -> io::Result<Vec<u8>> {
    let mut r = vec![5, 1, 0];
    let port = match target {
        Target::Name(name, port) => {
            if name.is_empty() || name.len() > 255 {
                return Err(io::Error::other("a name SOCKS5 cannot carry"));
            }
            r.push(3);
            r.push(name.len() as u8);
            r.extend_from_slice(name.as_bytes());
            *port
        }
        Target::Address(addr) => {
            match addr.ip() {
                IpAddr::V4(ip) => {
                    r.push(1);
                    r.extend_from_slice(&ip.octets());
                }
                IpAddr::V6(ip) => {
                    r.push(4);
                    r.extend_from_slice(&ip.octets());
                }
            }
            addr.port()
        }
    };
    r.extend_from_slice(&port.to_be_bytes());
    Ok(r)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn requests_name_the_target_the_socks5_way() {
        assert_eq!(
            request(&Target::Name("a.io".into(), 443)).unwrap(),
            [5, 1, 0, 3, 4, b'a', b'.', b'i', b'o', 1, 187]
        );
        assert_eq!(
            request(&Target::Address("1.2.3.4:80".parse().unwrap())).unwrap(),
            [5, 1, 0, 1, 1, 2, 3, 4, 0, 80]
        );
        let v6 = request(&Target::Address("[2001:db8::1]:443".parse().unwrap())).unwrap();
        assert_eq!((v6[3], v6.len()), (4, 4 + 16 + 2));
        assert!(request(&Target::Name(String::new(), 1)).is_err());
    }
}
