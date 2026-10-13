//! The relay's source, switchable while the relay runs.
//!
//! Switching places used to mean stopping the relay and starting another: the
//! port closed for a moment, the system proxy setting was put back and set
//! again, and whatever ran in between went out on the person's own address.
//! Now the relay keeps its port and only the source behind it changes.
//!
//! A switch also ends the connections that are open. A browser keeps its
//! connections to a site open for minutes and sends every request for that
//! site through them, so a switch that only reached new connections would
//! leave the open tabs on the old address. Ended, the browser opens new ones
//! at once, and those go through the new source. "Next IP" ends them for the
//! same reason, and so does stopping the relay: a disconnect that left the
//! open tunnels running would keep sending traffic through the proxy.
//!
//! How: every connection belongs to the turn it was accepted in. A switch
//! starts a new turn and ends the old one, and the connections of the old turn
//! see it end and close.

use std::sync::{Arc, Mutex, MutexGuard};

use tokio::sync::watch;

use crate::source::Source;

/// A source the relay forwards through, replaceable while the relay runs.
pub struct SwitchableSource {
    turn: Mutex<Turn>,
}

struct Turn {
    source: Arc<Source>,
    /// Set to true when this turn ends. Its connections watch it.
    ended: watch::Sender<bool>,
}

impl Turn {
    fn new(source: Arc<Source>) -> Self {
        let (ended, _) = watch::channel(false);
        Self { source, ended }
    }
}

/// What one connection holds: the source it was accepted under, and the
/// signal that its turn is over.
pub struct Ticket {
    pub source: Arc<Source>,
    ended: watch::Receiver<bool>,
}

impl Ticket {
    /// Resolves once the turn this connection belongs to has ended: a switch,
    /// "Next IP", or the relay stopping.
    pub async fn ended(&mut self) {
        // An error means the turn's sender is gone, which happens only after
        // the turn ended or the whole relay was dropped: over either way.
        let _ = self.ended.wait_for(|over| *over).await;
    }
}

impl SwitchableSource {
    pub fn new(source: Source) -> Self {
        Self {
            turn: Mutex::new(Turn::new(Arc::new(source))),
        }
    }

    fn lock(&self) -> MutexGuard<'_, Turn> {
        // A poisoned lock means a panic elsewhere while it was held. The turn
        // is a pointer and a channel, both still usable.
        self.turn.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The source in use now.
    pub fn current(&self) -> Arc<Source> {
        Arc::clone(&self.lock().source)
    }

    /// The ticket for a connection that was just accepted.
    pub fn ticket(&self) -> Ticket {
        let turn = self.lock();
        Ticket {
            source: Arc::clone(&turn.source),
            ended: turn.ended.subscribe(),
        }
    }

    /// Put `source` behind the relay. Every open connection ends, so the
    /// programs that held one come back through the new source.
    pub fn replace(&self, source: Source) {
        self.start_turn(Some(Arc::new(source)));
    }

    /// End every open connection and carry on with the same source.
    pub fn end_open_connections(&self) {
        self.start_turn(None);
    }

    /// Move to another upstream within the source (the next member of a list,
    /// a fresh free exit) and end the open connections, so every program comes
    /// back through it. Returns how the new upstream is described. Refused for
    /// a single proxy: there is no other one.
    pub async fn next_ip(&self) -> Result<String, String> {
        let label = self.current().advance().await?;
        self.end_open_connections();
        Ok(label)
    }

    /// Go back to the member of a group before the one in use, and end the
    /// open connections the same way. Refused for anything but a group.
    pub fn previous_ip(&self) -> Result<String, String> {
        let label = self.current().back()?;
        self.end_open_connections();
        Ok(label)
    }

    /// Use the member of a group that came from `line` of its list (from 0),
    /// and end the open connections the same way. Refused for anything but a
    /// group, and for a line it holds no member for.
    pub fn go_to_line(&self, line: usize) -> Result<String, String> {
        let label = self.current().go_to_line(line)?;
        self.end_open_connections();
        Ok(label)
    }

    fn start_turn(&self, source: Option<Arc<Source>>) {
        let old = {
            let mut turn = self.lock();
            let source = source.unwrap_or_else(|| Arc::clone(&turn.source));
            std::mem::replace(&mut *turn, Turn::new(source))
        };
        // `send_replace` sets the value even when no connection is listening,
        // so a ticket taken from the old turn a moment ago still sees the end.
        old.ended.send_replace(true);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::upstream;
    use std::time::Duration;

    fn fixed(line: &str) -> Source {
        Source::Fixed(upstream::parse(line).unwrap())
    }

    async fn ends_soon(t: &mut Ticket) -> bool {
        tokio::time::timeout(Duration::from_millis(500), t.ended())
            .await
            .is_ok()
    }

    #[tokio::test]
    async fn a_ticket_of_the_current_turn_does_not_end_by_itself() {
        let s = SwitchableSource::new(fixed("198.51.100.1:8080"));
        let mut t = s.ticket();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), t.ended())
                .await
                .is_err(),
            "nothing switched, so the connection must keep going"
        );
    }

    #[tokio::test]
    async fn replacing_ends_the_open_tickets_and_new_ones_get_the_new_source() {
        let s = SwitchableSource::new(fixed("198.51.100.1:8080"));
        let mut before = s.ticket();
        assert!(before.source.in_use_now().contains("198.51.100.1"));

        s.replace(fixed("198.51.100.2:8080"));
        assert!(ends_soon(&mut before).await, "the old connection must end");

        let mut after = s.ticket();
        assert!(after.source.in_use_now().contains("198.51.100.2"));
        assert!(s.current().in_use_now().contains("198.51.100.2"));
        assert!(
            tokio::time::timeout(Duration::from_millis(50), after.ended())
                .await
                .is_err(),
            "a connection of the new turn keeps going"
        );
    }

    #[tokio::test]
    async fn ending_open_connections_keeps_the_source() {
        let s = SwitchableSource::new(fixed("198.51.100.1:8080"));
        let mut open = s.ticket();
        s.end_open_connections();
        assert!(ends_soon(&mut open).await);
        assert!(s.current().in_use_now().contains("198.51.100.1"));
    }

    #[tokio::test]
    async fn every_earlier_turn_ends_not_only_the_last() {
        let s = SwitchableSource::new(fixed("198.51.100.1:8080"));
        let mut first = s.ticket();
        s.replace(fixed("198.51.100.2:8080"));
        let mut second = s.ticket();
        s.replace(fixed("198.51.100.3:8080"));
        assert!(ends_soon(&mut first).await);
        assert!(ends_soon(&mut second).await);
    }

    #[tokio::test]
    async fn next_ip_is_refused_for_a_single_proxy_and_ends_nothing() {
        let s = SwitchableSource::new(fixed("198.51.100.1:8080"));
        let mut open = s.ticket();
        assert!(s.next_ip().await.is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(50), open.ended())
                .await
                .is_err(),
            "a refused Next IP must not cut the connection the person still has"
        );
    }

    #[tokio::test]
    async fn back_and_go_to_on_a_list_end_the_open_connections_and_refusals_end_nothing() {
        let members = (1..=3)
            .map(|i| upstream::parse(&format!("198.51.100.{i}:8080")).unwrap())
            .collect();
        let list = crate::source::List::new(members, crate::source::Rotation::OnFailure).unwrap();
        let s = SwitchableSource::new(Source::List(list));
        let mut open = s.ticket();
        assert!(s.go_to_line(2).unwrap().contains("198.51.100.3"));
        assert!(ends_soon(&mut open).await);
        let mut open = s.ticket();
        assert!(s.previous_ip().unwrap().contains("198.51.100.2"));
        assert!(ends_soon(&mut open).await);
        let mut open = s.ticket();
        assert!(s.go_to_line(9).is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(50), open.ended())
                .await
                .is_err(),
            "a refused pick must not cut the connection the person has"
        );
    }

    #[tokio::test]
    async fn next_ip_on_a_list_moves_on_and_ends_the_open_connections() {
        let members = (1..=3)
            .map(|i| upstream::parse(&format!("198.51.100.{i}:8080")).unwrap())
            .collect();
        let list = crate::source::List::new(members, crate::source::Rotation::OnFailure).unwrap();
        let s = SwitchableSource::new(Source::List(list));
        let mut open = s.ticket();
        assert_eq!(open.source.take().await.host, "198.51.100.1");
        let label = s.next_ip().await.unwrap();
        assert!(label.contains("198.51.100.2"), "{label}");
        assert!(ends_soon(&mut open).await);
        assert_eq!(s.ticket().source.take().await.host, "198.51.100.2");
    }
}
