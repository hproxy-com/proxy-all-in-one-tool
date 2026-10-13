//! The VPN's file descriptor (Android hands one over when the VPN starts):
//! each read is one packet from the phone, each write one packet to it.
//! The tunnel owns it; dropping it closes it, and closing it ends the VPN.
//!
//! A new descriptor can take over while the tunnel runs (`run_with`'s
//! `swaps`): the phone app opens the VPN again whenever the set of apps in it
//! changes (a firewall rule, connecting, disconnecting), Android hands over a
//! new descriptor and closes the old one, and the connections already open
//! carry on through the new one, because the TCP/IP stack and everything in
//! it stay as they are.

use std::future::Future;
use std::io;
use std::net::SocketAddr;
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::Arc;
use std::time::Duration;

use tokio::io::unix::AsyncFd;
use tokio::sync::{mpsc, watch};

use crate::gate::Exits;

/// Packets waiting in each direction between the descriptor and the stack.
const QUEUED: usize = 512;
/// When reading fails (Android closed the old descriptor as it opened a new
/// one), the new one is waited for this long before the tunnel gives up.
const SWAP_GRACE: Duration = Duration::from_secs(3);

/// Runs the tunnel on `fd` until `stop` finishes or the descriptor fails,
/// every connection through the relay on `relay`.
pub async fn run(fd: OwnedFd, relay: SocketAddr, stop: impl Future<Output = ()>) -> io::Result<()> {
    let (_none, swaps) = mpsc::channel(1);
    run_with(fd, Exits::through(relay), swaps, stop).await
}

/// `run`, with a gate deciding each connection's way out (`exits`), and new
/// descriptors taking over as they arrive on `swaps`.
pub async fn run_with(
    fd: OwnedFd,
    exits: Exits,
    mut swaps: mpsc::Receiver<OwnedFd>,
    stop: impl Future<Output = ()>,
) -> io::Result<()> {
    set_nonblocking(&fd)?;
    let (current, watching) = watch::channel(Arc::new(AsyncFd::new(fd)?));
    let (phone_in, from_phone) = mpsc::channel::<Vec<u8>>(QUEUED);
    let (to_phone, mut phone_out) = mpsc::channel::<Vec<u8>>(QUEUED);

    let reader = {
        let mut watching = watching.clone();
        tokio::spawn(async move {
            let mut buf = vec![0u8; crate::MTU as usize + 64];
            loop {
                let fd = watching.borrow_and_update().clone();
                let read = tokio::select! {
                    r = read_packet(&fd, &mut buf) => r,
                    _ = watching.changed() => continue,
                };
                match read {
                    Ok(n) => {
                        if n > 0 && phone_in.send(buf[..n].to_vec()).await.is_err() {
                            return;
                        }
                    }
                    Err(e) => {
                        // Android closes the old descriptor as it opens a new
                        // one: wait for that one before calling it the end.
                        match tokio::time::timeout(SWAP_GRACE, watching.changed()).await {
                            Ok(Ok(())) => continue,
                            _ => {
                                log::warn!("tunnel: reading the VPN failed: {e}");
                                return;
                            }
                        }
                    }
                }
            }
        })
    };
    let writer = {
        let watching = watching.clone();
        tokio::spawn(async move {
            while let Some(p) = phone_out.recv().await {
                let fd = watching.borrow().clone();
                if let Err(e) = write_packet(&fd, &p).await {
                    // A packet lost on a descriptor being replaced is sent
                    // again by the app's TCP; only a lasting failure is news,
                    // and the reader ends the tunnel for that.
                    log::debug!("tunnel: writing to the VPN failed: {e}");
                }
            }
        })
    };

    let stack = crate::stack::run_with(from_phone, to_phone, exits, stop);
    tokio::pin!(stack);
    let mut more = true;
    loop {
        tokio::select! {
            _ = &mut stack => break,
            fd = swaps.recv(), if more => match fd {
                Some(fd) => match set_nonblocking(&fd).and_then(|_| AsyncFd::new(fd)) {
                    Ok(fd) => {
                        let _ = current.send(Arc::new(fd));
                        log::info!("tunnel: carried on through a new VPN descriptor");
                    }
                    Err(e) => log::warn!("tunnel: the new VPN descriptor could not be used: {e}"),
                },
                None => more = false,
            },
        }
    }
    reader.abort();
    writer.abort();
    let _ = reader.await;
    let _ = writer.await;
    // The last handle to the descriptor goes here, which closes it.
    Ok(())
}

fn set_nonblocking(fd: &OwnedFd) -> io::Result<()> {
    let raw = fd.as_raw_fd();
    // SAFETY: fcntl on a descriptor this function borrows, with no pointers.
    let flags = unsafe { libc::fcntl(raw, libc::F_GETFL) };
    if flags < 0 || unsafe { libc::fcntl(raw, libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

async fn read_packet(fd: &AsyncFd<OwnedFd>, buf: &mut [u8]) -> io::Result<usize> {
    loop {
        let mut ready = fd.readable().await?;
        // SAFETY: read into a buffer this function owns, never past its length.
        let r =
            ready.try_io(
                |inner| match unsafe { libc::read(inner.as_raw_fd(), buf.as_mut_ptr().cast(), buf.len()) } {
                    n if n >= 0 => Ok(n as usize),
                    _ => Err(io::Error::last_os_error()),
                },
            );
        match r {
            Ok(result) => return result,
            Err(_would_block) => continue,
        }
    }
}

async fn write_packet(fd: &AsyncFd<OwnedFd>, packet: &[u8]) -> io::Result<()> {
    loop {
        let mut ready = fd.writable().await?;
        // SAFETY: write from a slice this function borrows, never past its length.
        let r = ready.try_io(|inner| {
            match unsafe { libc::write(inner.as_raw_fd(), packet.as_ptr().cast(), packet.len()) } {
                n if n >= 0 => Ok(()),
                _ => Err(io::Error::last_os_error()),
            }
        });
        match r {
            Ok(result) => return result,
            Err(_would_block) => continue,
        }
    }
}
