//! The firewall's gate (the phone app's "Which apps"): each new connection
//! in the VPN goes through the proxy, straight out, or nowhere, by the app
//! that opened it and the network the phone is on.
//!
//! The app (Kotlin) knows the rules and the network, so it hands over the
//! answer for every app as a table: a decision per app (by its user id) and
//! a default for every app the table does not name. It sends a new table
//! whenever a rule changes, the phone moves between Wi-Fi and mobile data, or
//! a proxy connects or disconnects. With nobody named, every connection takes
//! the default and no app is looked up at all: a phone with no rules pays
//! nothing for the firewall.
//!
//! A blocked app that tries is worth a word to the person (NetGuard does it,
//! and it is the motivation here): once a minute per app at most, an event
//! the app turns into a notification when the person wants them.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant};

use hproxy_tunnel::{Decision, Flow, Gate};
use serde::{Deserialize, Serialize};

use crate::events::Events;
use crate::owner::OwnerOf;

/// A blocked app is told about once in this long at most.
const TELL_EVERY: Duration = Duration::from_secs(60);

/// The table as the app sends it.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableInput {
    /// Decision per app, by user id.
    #[serde(default)]
    pub decisions: HashMap<u32, Way>,
    /// For every app not named.
    pub default: Way,
    /// Say when a blocked app tries.
    #[serde(default)]
    pub notify: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Way {
    Proxy,
    Direct,
    Block,
}

impl From<Way> for Decision {
    fn from(w: Way) -> Decision {
        match w {
            Way::Proxy => Decision::Proxy,
            Way::Direct => Decision::Direct,
            Way::Block => Decision::Block,
        }
    }
}

struct Table {
    by_uid: HashMap<u32, Decision>,
    default: Decision,
    notify: bool,
}

/// A blocked app tried to connect.
#[derive(Debug, Serialize)]
pub struct Tried {
    pub uid: u32,
    /// The name it looked up, else the address.
    pub host: String,
    pub port: u16,
    pub udp: bool,
}

pub struct Firewall {
    table: RwLock<Table>,
    owner: RwLock<Option<Arc<dyn OwnerOf>>>,
    events: Arc<Events>,
    told: Mutex<HashMap<u32, Instant>>,
}

impl Firewall {
    pub fn new(events: Arc<Events>) -> Firewall {
        Firewall {
            table: RwLock::new(Table {
                by_uid: HashMap::new(),
                default: Decision::Proxy,
                notify: false,
            }),
            owner: RwLock::new(None),
            events,
            told: Mutex::new(HashMap::new()),
        }
    }

    /// How apps are told apart (owner.rs).
    pub fn set_owner(&self, owner: Arc<dyn OwnerOf>) {
        *self.owner.write().unwrap_or_else(|e| e.into_inner()) = Some(owner);
    }

    pub fn set_table(&self, input: TableInput) {
        let default = input.default.into();
        let by_uid = input
            .decisions
            .into_iter()
            .map(|(uid, w)| (uid, Decision::from(w)))
            // An entry that says what the default says needs no lookup.
            .filter(|(_, d)| *d != default)
            .collect();
        *self.table.write().unwrap_or_else(|e| e.into_inner()) = Table {
            by_uid,
            default,
            notify: input.notify,
        };
    }

    fn tell(&self, uid: u32, flow: &Flow) {
        let now = Instant::now();
        let mut told = self.told.lock().unwrap_or_else(|e| e.into_inner());
        if told.get(&uid).is_some_and(|at| now.duration_since(*at) < TELL_EVERY) {
            return;
        }
        told.insert(uid, now);
        if told.len() > 512 {
            told.retain(|_, at| now.duration_since(*at) < TELL_EVERY);
        }
        drop(told);
        self.events.emit(
            "blocked",
            Tried {
                uid,
                host: flow.name.clone().unwrap_or_else(|| flow.to.ip().to_string()),
                port: flow.to.port(),
                udp: flow.udp,
            },
        );
    }
}

impl Gate for Firewall {
    fn decide(&self, flow: &Flow) -> Decision {
        let table = self.table.read().unwrap_or_else(|e| e.into_inner());
        if table.by_uid.is_empty() {
            return table.default;
        }
        let owner = self.owner.read().unwrap_or_else(|e| e.into_inner()).clone();
        let uid = owner.and_then(|o| o.owner(flow.udp, flow.from, flow.to));
        let decision = uid.and_then(|u| table.by_uid.get(&u).copied()).unwrap_or(table.default);
        if decision == Decision::Block && table.notify {
            if let Some(uid) = uid {
                drop(table);
                self.tell(uid, flow);
            }
        }
        decision
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::SocketAddr;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Every connection belongs to app 10123; counts the lookups.
    struct One(AtomicUsize);
    impl OwnerOf for One {
        fn owner(&self, _: bool, _: SocketAddr, _: SocketAddr) -> Option<u32> {
            self.0.fetch_add(1, Ordering::SeqCst);
            Some(10123)
        }
    }

    fn flow() -> Flow {
        Flow {
            udp: false,
            from: "198.18.0.1:40000".parse().unwrap(),
            to: "198.18.0.9:443".parse().unwrap(),
            name: Some("i.instagram.com".into()),
        }
    }

    fn table(decisions: &[(u32, Way)], default: Way, notify: bool) -> TableInput {
        TableInput {
            decisions: decisions.iter().copied().collect(),
            default,
            notify,
        }
    }

    #[test]
    fn with_nobody_named_no_app_is_looked_up() {
        let events = Arc::new(Events::default());
        let fw = Firewall::new(events);
        let owner = Arc::new(One(AtomicUsize::new(0)));
        fw.set_owner(owner.clone());
        fw.set_table(table(&[], Way::Proxy, true));
        assert_eq!(fw.decide(&flow()), Decision::Proxy);
        fw.set_table(table(&[(10123, Way::Proxy)], Way::Proxy, true));
        assert_eq!(fw.decide(&flow()), Decision::Proxy);
        assert_eq!(
            owner.0.load(Ordering::SeqCst),
            0,
            "an entry that says the default needs no lookup"
        );
    }

    #[test]
    fn a_named_app_gets_its_own_way_and_a_blocked_one_is_told_once_a_minute() {
        let events = Arc::new(Events::default());
        let fw = Firewall::new(events.clone());
        fw.set_owner(Arc::new(One(AtomicUsize::new(0))));
        fw.set_table(table(&[(10123, Way::Block)], Way::Proxy, true));
        assert_eq!(fw.decide(&flow()), Decision::Block);
        assert_eq!(fw.decide(&flow()), Decision::Block);
        let told: serde_json::Value = serde_json::from_str(&events.poll(Duration::from_millis(10)).unwrap()).unwrap();
        assert_eq!(told["type"], "blocked");
        assert_eq!(told["uid"], 10123);
        assert_eq!(told["host"], "i.instagram.com");
        assert!(
            events.poll(Duration::from_millis(10)).is_none(),
            "told once, not on every try"
        );

        fw.set_table(table(&[(10123, Way::Direct)], Way::Block, false));
        assert_eq!(fw.decide(&flow()), Decision::Direct);
    }

    #[test]
    fn an_app_nobody_can_name_takes_the_default() {
        struct Nobody;
        impl OwnerOf for Nobody {
            fn owner(&self, _: bool, _: SocketAddr, _: SocketAddr) -> Option<u32> {
                None
            }
        }
        let fw = Firewall::new(Arc::new(Events::default()));
        fw.set_owner(Arc::new(Nobody));
        fw.set_table(table(&[(10123, Way::Block)], Way::Direct, true));
        assert_eq!(fw.decide(&flow()), Decision::Direct);
    }

    #[test]
    fn the_table_reads_as_the_app_sends_it() {
        let t: TableInput =
            serde_json::from_str(r#"{"decisions":{"10123":"block","10200":"direct"},"default":"proxy","notify":true}"#)
                .unwrap();
        assert_eq!(t.decisions[&10123], Way::Block);
        assert_eq!(t.default, Way::Proxy);
        assert!(t.notify);
    }
}
