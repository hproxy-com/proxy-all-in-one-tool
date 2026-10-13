//! A connection the gate lets out directly: from this app's own socket, which
//! Android keeps outside the VPN, so it leaves exactly as it would without
//! HProxy (the phone's own address, its own DNS). Used by the firewall for an
//! app that may use the internet but is not sent through the proxy, while the
//! VPN has to carry it anyway (it is blocked on the other kind of network).

use std::io;
use std::sync::Arc;
use std::time::Duration;

use tokio::net::TcpStream;
use tokio::sync::{mpsc, Notify};

use crate::relay::{bridge, FromRelay, Target};

/// A site answers a direct connection within this, or not at all.
const CONNECT_WITHIN: Duration = Duration::from_secs(20);

/// Carries one connection straight to the site.
pub async fn carry(
    target: Target,
    to_site: mpsc::Receiver<Vec<u8>>,
    from_site: mpsc::Sender<FromRelay>,
    wake: Arc<Notify>,
) {
    let opening = open(&target);
    bridge(opening, &target, CONNECT_WITHIN, to_site, from_site, wake).await
}

/// The site itself: a name looked up here, with the phone's own DNS.
pub async fn open(target: &Target) -> io::Result<TcpStream> {
    let s = match target {
        Target::Name(name, port) => TcpStream::connect((name.as_str(), *port)).await?,
        Target::Address(addr) => TcpStream::connect(addr).await?,
    };
    s.set_nodelay(true)?;
    Ok(s)
}
