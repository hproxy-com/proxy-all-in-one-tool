//! The library: every place a person keeps, owned here rather than by a
//! window, so every door (the window, the tray, the phone, the command line)
//! reads the same places, and none of them needs a password to show one.
//!
//!   proxies  one line each, saved by the person, with a name when they gave
//!            one and what its last check found
//!   groups   named sets of lines the relay moves through by a rule
//!   picked   the place the switch connects to, remembered between starts
//!
//! A line keeps its password here and only here. What a screen gets is a
//! view ([`Library::view`]): the address, the login name and what the line
//! targets, never the password. A connection asks for a place by its id and
//! the line is read here, on the side that dials it.

use std::collections::HashSet;

use serde::{Deserialize, Serialize};

use crate::targeting::{self, Targeting};

/// The library's shape. A file written by a later shape is read as far as it
/// goes; fields this one does not know are kept out, never invented.
pub const VERSION: u32 = 1;
/// Ceilings that only a runaway import reaches. Saved proxies are shown whole
/// on every change, so they stop at ten thousand (the window held a thousand);
/// a batch bigger than that is a group, which is shown by its size and holds
/// a hundred thousand.
pub const MAX_PROXIES: usize = 10_000;
pub const MAX_GROUPS: usize = 1_000;
pub const MAX_GROUP_LINES: usize = 100_000;
/// The longest name a place keeps.
pub const MAX_NAME: usize = 60;

/// What the last check or probe of a saved proxy found.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verdict {
    /// A connection through it carries tunnels (https sites, apps). A proxy
    /// that only answered plain HTTP is not ok, however fast it answered.
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    /// Lowercase country code of the exit, for the flag.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cc: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub place: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_ip: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anonymity: Option<String>,
    /// The row's words from the engine's verdict (`hproxy_probe::usable`):
    /// "Working · 180 ms", "Can't open https sites". Absent for a live
    /// probe's answer and for checks saved before the verdict existed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub says: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tone: Option<hproxy_probe::Tone>,
    /// How to speak to it for a tunnel, as the check proved. The relay
    /// starts with it, so a bare SOCKS5 line is never dialled as HTTP first.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub way: Option<hproxy_probe::Way>,
    /// Whether the exit is in a data center, from the check's location data:
    /// what kind of proxy it is when its login does not say.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub datacenter: Option<bool>,
    /// Unix milliseconds.
    #[serde(default)]
    pub at: u64,
}

impl Verdict {
    /// What a check says about a proxy, the way its row shows it: the engine's
    /// verdict on whether it carries a connection, not merely whether
    /// something answered. Every door that saves a check reads it this way.
    pub fn of_check(r: &hproxy_probe::CheckResult, at: u64) -> Verdict {
        let usable = r.usable.clone().unwrap_or_else(|| hproxy_probe::usable(r, None, None));
        Verdict {
            ok: usable.carries,
            latency_ms: r.latency_ms.and_then(|ms| u64::try_from(ms).ok()),
            cc: r.country_code.as_deref().map(str::to_ascii_lowercase),
            place: place_words(r.city.as_deref(), r.country.as_deref()),
            exit_ip: r.exit_ip.clone(),
            anonymity: r.anonymity.clone(),
            says: Some(usable.says),
            tone: Some(usable.tone),
            way: usable.way,
            datacenter: r.is_datacenter,
            at,
        }
    }
}

/// "Berlin, Germany", or whichever of the two is known.
pub fn place_words(city: Option<&str>, country: Option<&str>) -> Option<String> {
    match (city.filter(|c| !c.is_empty()), country.filter(|c| !c.is_empty())) {
        (Some(c), Some(k)) => Some(format!("{c}, {k}")),
        (Some(c), None) => Some(c.to_string()),
        (None, Some(k)) => Some(k.to_string()),
        (None, None) => None,
    }
}

/// One saved proxy. `line` holds the password and never leaves this crate's
/// callers on the dialling side.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Proxy {
    pub id: String,
    pub line: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default)]
    pub added_at: u64,
    #[serde(default)]
    pub last_used_at: u64,
    #[serde(default)]
    pub uses: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last: Option<Verdict>,
}

/// How a group moves through its members (the relay's rotation rules).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Rule {
    /// The same member until it stops answering.
    OnFailure,
    /// A new member every `n` minutes.
    EveryMinutes,
    /// A new member for every connection.
    EveryConnection,
    /// A new member every `n` connections.
    EveryN,
    /// A member at random for every connection.
    Random,
}

impl Rule {
    /// Whether the rule reads a number (`n`).
    pub fn takes_n(self) -> bool {
        matches!(self, Rule::EveryMinutes | Rule::EveryN)
    }
}

/// What every member of a group targets alike, worked out when it is saved.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSummary {
    /// The targeting all members share (a session is never shared, so it is
    /// never here); empty when they share nothing.
    pub shared: Targeting,
    /// How many members hold a session of their own.
    pub sessions: usize,
}

/// A named set of lines the relay moves through by a rule.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Group {
    pub id: String,
    pub name: String,
    pub lines: Vec<String>,
    pub rule: Rule,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,
    #[serde(default)]
    pub added_at: u64,
    #[serde(default)]
    pub last_used_at: u64,
    #[serde(default)]
    pub uses: u64,
    #[serde(default)]
    pub summary: GroupSummary,
}

/// The place the switch connects to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Place {
    /// One of the saved proxies.
    Proxy { id: String },
    /// One of the groups.
    Group { id: String },
    /// The free pool: a country ("" anywhere) and a protocol, or one exit
    /// picked from its list.
    Free {
        #[serde(default)]
        country: String,
        #[serde(default)]
        socks5: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        exit: Option<String>,
        #[serde(default, rename = "exitCountry", skip_serializing_if = "Option::is_none")]
        exit_country: Option<String>,
    },
}

/// Everything a person keeps.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Library {
    #[serde(default = "version_now")]
    pub version: u32,
    #[serde(default)]
    pub proxies: Vec<Proxy>,
    #[serde(default)]
    pub groups: Vec<Group>,
    #[serde(default)]
    pub picked: Option<Place>,
    /// The window's own storage (before the library existed) was moved in.
    /// It happens once; after it, that storage is never read again.
    #[serde(default)]
    pub moved_from_window: bool,
}

fn version_now() -> u32 {
    VERSION
}

impl Default for Library {
    fn default() -> Self {
        Self {
            version: VERSION,
            proxies: Vec::new(),
            groups: Vec::new(),
            picked: None,
            moved_from_window: false,
        }
    }
}

/// A group as the window sends it to be saved: a new one without an id.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInput {
    #[serde(default)]
    pub id: Option<String>,
    pub name: String,
    pub lines: Vec<String>,
    pub rule: Rule,
    #[serde(default)]
    pub n: Option<u32>,
}

/// What the window kept before the library existed, exactly as it kept it
/// (its localStorage, in the window's own words). An entry that does not read
/// is left out on its own: one damaged entry never stops the rest moving in.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowStorage {
    #[serde(default, deserialize_with = "each_that_reads")]
    pub saved: Vec<WindowProxy>,
    #[serde(default, deserialize_with = "each_that_reads")]
    pub lists: Vec<WindowList>,
    #[serde(default, deserialize_with = "if_it_reads")]
    pub target: Option<WindowTarget>,
}

/// The entries of a list that read as `T`; the others are left out.
fn each_that_reads<'de, D, T>(d: D) -> Result<Vec<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    let values = Option::<Vec<serde_json::Value>>::deserialize(d)?.unwrap_or_default();
    Ok(values
        .into_iter()
        .filter_map(|v| serde_json::from_value(v).ok())
        .collect())
}

/// A value that reads as `T`, or nothing.
fn if_it_reads<'de, D, T>(d: D) -> Result<Option<T>, D::Error>
where
    D: serde::Deserializer<'de>,
    T: serde::de::DeserializeOwned,
{
    Ok(Option::<serde_json::Value>::deserialize(d)?.and_then(|v| serde_json::from_value(v).ok()))
}

/// A saved proxy as the window kept it. Only the line must read; a name or a
/// last check that does not is dropped, the proxy kept. The window's id is not
/// read: the library gives every line its own (`proxy_id`), so the same line
/// pasted again later is found, never saved twice.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowProxy {
    pub line: String,
    #[serde(default, deserialize_with = "if_it_reads")]
    pub name: Option<String>,
    #[serde(default)]
    pub added_at: u64,
    #[serde(default)]
    pub last_used_at: u64,
    #[serde(default)]
    pub uses: u64,
    #[serde(default, deserialize_with = "if_it_reads")]
    pub last: Option<Verdict>,
}

/// A group as the window kept it, its rule as a word.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WindowList {
    pub id: String,
    #[serde(default, deserialize_with = "if_it_reads")]
    pub name: Option<String>,
    #[serde(default, deserialize_with = "each_that_reads")]
    pub lines: Vec<String>,
    #[serde(default, deserialize_with = "if_it_reads")]
    pub rule: Option<String>,
    #[serde(default, deserialize_with = "if_it_reads")]
    pub n: Option<u32>,
    #[serde(default)]
    pub added_at: u64,
    #[serde(default)]
    pub last_used_at: u64,
    #[serde(default)]
    pub uses: u64,
}

/// The place the window had picked, in the window's old words.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WindowTarget {
    Fixed {
        line: String,
    },
    List {
        id: String,
    },
    Free {
        #[serde(default)]
        country: String,
        #[serde(default)]
        socks5: bool,
        #[serde(default)]
        exit: Option<String>,
        #[serde(default, rename = "exitCountry")]
        exit_country: Option<String>,
    },
}

/// A saved proxy as a screen sees it: never the password.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyView {
    pub id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// `host:port`, IPv6 in brackets.
    pub address: String,
    /// The login name, when the line has one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// The scheme the line asked for (`http`, `socks5`), when it named one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scheme: Option<String>,
    /// What the login targets (a session, a region); absent when nothing.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about: Option<Targeting>,
    pub added_at: u64,
    pub last_used_at: u64,
    pub uses: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last: Option<Verdict>,
}

impl ProxyView {
    /// What the proxy is called on every screen and in every tool: the name
    /// it was given; else the session its login holds ("Session 7f3a9c21"),
    /// since a hundred sessions on one gateway share an address; else its
    /// address. Never the password. (The window says it the same way,
    /// desktop-app/src/lib/connect.ts, `proxyTitle`.)
    pub fn title(&self) -> String {
        if let Some(name) = self.name.as_deref().filter(|n| !n.trim().is_empty()) {
            return name.to_string();
        }
        if let Some(session) = self.about.as_ref().and_then(|t| t.session.as_deref()) {
            return format!("Session {session}");
        }
        self.address.clone()
    }
}

/// A group as a screen sees it: its size and what its members target, never
/// a line.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupView {
    pub id: String,
    pub name: String,
    pub size: usize,
    pub rule: Rule,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub n: Option<u32>,
    pub added_at: u64,
    pub last_used_at: u64,
    pub uses: u64,
    pub summary: GroupSummary,
}

/// One member of a group as a screen sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberView {
    /// Its place in the group, from 0: what "switch to this one" names.
    pub index: usize,
    pub address: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub about: Option<Targeting>,
}

/// The whole library as a screen sees it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LibraryView {
    pub proxies: Vec<ProxyView>,
    pub groups: Vec<GroupView>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub picked: Option<Place>,
}

/// A saved proxy's id: FNV-1a over the trimmed line's UTF-16 units, in base
/// 36. The window computed ids this way before the library existed, so a line
/// saved then and pasted again now is recognised as the same proxy.
pub fn proxy_id(line: &str) -> String {
    let mut h: u32 = 2_166_136_261;
    for unit in line.trim().encode_utf16() {
        h ^= u32::from(unit);
        h = h.wrapping_mul(16_777_619);
    }
    base36(u64::from(h))
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".into();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).unwrap_or_default()
}

/// A new group's id: `g` and the time, with a counter so two in the same
/// millisecond differ.
fn group_id(now: u64) -> String {
    use std::sync::atomic::{AtomicU64, Ordering};
    static NEXT: AtomicU64 = AtomicU64::new(0);
    format!("g{}{}", base36(now), base36(NEXT.fetch_add(1, Ordering::Relaxed)))
}

/// A name the way it is kept: runs of spaces made one, trimmed, capped.
pub fn clean_name(name: &str) -> String {
    let joined = name.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(MAX_NAME).collect::<String>().trim().to_string()
}

/// The lines of a paste, trimmed, blanks and repeats dropped, in order.
fn clean_lines(lines: &[String], cap: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    lines
        .iter()
        .map(|l| l.trim().trim_start_matches('\u{feff}').to_string())
        .filter(|l| !l.is_empty() && seen.insert(l.clone()))
        .take(cap)
        .collect()
}

/// What a line is, for a screen: never its password.
struct Shown {
    address: String,
    user: Option<String>,
    scheme: Option<String>,
    about: Option<Targeting>,
}

impl Shown {
    /// A line the engine cannot read still gets a row, so it can be removed.
    fn unreadable() -> Self {
        Self {
            address: "a line that cannot be read".into(),
            user: None,
            scheme: None,
            about: None,
        }
    }
}

/// Read a line for a screen; `None` for a line the engine cannot read.
fn read_line(line: &str) -> Option<Shown> {
    let parsed = hproxy_probe::line::parse(line).ok()?;
    let user = parsed.auth.as_ref().map(|(u, _)| u.clone());
    let about = user.as_deref().map(targeting::read).filter(|t| !t.is_empty());
    let scheme = parsed.scheme.map(|s| match s {
        hproxy_probe::line::Scheme::Http => "http".to_string(),
        hproxy_probe::line::Scheme::Socks4 => "socks4".to_string(),
        hproxy_probe::line::Scheme::Socks5 => "socks5".to_string(),
    });
    Some(Shown {
        address: parsed.addr(),
        user,
        scheme,
        about,
    })
}

/// What all of a group's lines target alike, and how many hold a session.
pub fn summarise(lines: &[String]) -> GroupSummary {
    let mut sessions = 0;
    let mut shared: Option<Targeting> = None;
    for line in lines {
        let t = read_line(line).and_then(|s| s.about).unwrap_or_default();
        if t.session.is_some() {
            sessions += 1;
        }
        let mut t = t;
        t.session = None;
        shared = Some(match shared {
            None => t,
            Some(s) => Targeting {
                country: s.country.filter(|v| t.country.as_ref() == Some(v)),
                region: s.region.filter(|v| t.region.as_ref() == Some(v)),
                city: s.city.filter(|v| t.city.as_ref() == Some(v)),
                asn: s.asn.filter(|v| t.asn.as_ref() == Some(v)),
                session: None,
                minutes: s.minutes.filter(|v| t.minutes.as_ref() == Some(v)),
                kind: s.kind.filter(|v| t.kind.as_ref() == Some(v)),
            },
        });
    }
    GroupSummary {
        shared: shared.unwrap_or_default(),
        sessions,
    }
}

impl Library {
    pub fn proxy(&self, id: &str) -> Option<&Proxy> {
        self.proxies.iter().find(|p| p.id == id)
    }

    pub fn group(&self, id: &str) -> Option<&Group> {
        self.groups.iter().find(|g| g.id == id)
    }

    /// Save `lines` as proxies. New ones go on top in the order given (the
    /// first line ends up first); a line already saved keeps its place. Lines
    /// the engine cannot read are left out, and so are new lines past
    /// `MAX_PROXIES`. Returns the id of every line that is saved now, in the
    /// order given, whether it was new or not.
    pub fn add_proxies(&mut self, lines: &[String], now: u64) -> Vec<String> {
        let mut known: HashSet<String> = self.proxies.iter().map(|p| p.id.clone()).collect();
        let mut room = MAX_PROXIES.saturating_sub(self.proxies.len());
        let mut ids = Vec::new();
        let mut fresh = Vec::new();
        for line in clean_lines(lines, MAX_PROXIES) {
            if hproxy_probe::line::parse(&line).is_err() {
                continue;
            }
            let id = proxy_id(&line);
            if !known.contains(&id) {
                if room == 0 {
                    continue;
                }
                room -= 1;
                known.insert(id.clone());
                fresh.push(Proxy {
                    id: id.clone(),
                    line,
                    name: None,
                    added_at: now,
                    last_used_at: 0,
                    uses: 0,
                    last: None,
                });
            }
            ids.push(id);
        }
        self.proxies.splice(0..0, fresh);
        ids
    }

    /// A connection went through `id`: count it and bring it to the top.
    pub fn proxy_used(&mut self, id: &str, now: u64) {
        if let Some(at) = self.proxies.iter().position(|p| p.id == id) {
            let mut p = self.proxies.remove(at);
            p.uses += 1;
            p.last_used_at = now;
            self.proxies.insert(0, p);
        }
    }

    /// Give a saved proxy a name, or take it away with an empty one.
    pub fn rename_proxy(&mut self, id: &str, name: &str) -> bool {
        let name = clean_name(name);
        match self.proxies.iter_mut().find(|p| p.id == id) {
            Some(p) => {
                p.name = (!name.is_empty()).then_some(name);
                true
            }
            None => false,
        }
    }

    /// Give a group another name. A group always has one: an empty name
    /// leaves it as it is.
    pub fn rename_group(&mut self, id: &str, name: &str) -> bool {
        let name = clean_name(name);
        if name.is_empty() {
            return false;
        }
        match self.groups.iter_mut().find(|g| g.id == id) {
            Some(g) => {
                g.name = name;
                true
            }
            None => false,
        }
    }

    /// Forget a saved proxy, and the pick when it was this one.
    pub fn forget_proxy(&mut self, id: &str) -> bool {
        let before = self.proxies.len();
        self.proxies.retain(|p| p.id != id);
        if matches!(&self.picked, Some(Place::Proxy { id: picked }) if picked == id) {
            self.picked = None;
        }
        self.proxies.len() != before
    }

    /// Keep what the last check or probe of `id` found.
    pub fn set_verdict(&mut self, id: &str, verdict: Verdict) -> bool {
        match self.proxies.iter_mut().find(|p| p.id == id) {
            Some(p) => {
                p.last = Some(verdict);
                true
            }
            None => false,
        }
    }

    /// Save a group: replace the one with the input's id, or add a new one on
    /// top. Lines are trimmed, blanks and repeats dropped, unreadable ones left
    /// out. Returns its id.
    pub fn save_group(&mut self, input: GroupInput, now: u64) -> Result<String, String> {
        let lines: Vec<String> = clean_lines(&input.lines, MAX_GROUP_LINES)
            .into_iter()
            .filter(|l| hproxy_probe::line::parse(l).is_ok())
            .collect();
        if lines.is_empty() {
            return Err("none of the lines can be read as a proxy".into());
        }
        let n = if input.rule.takes_n() {
            Some(input.n.unwrap_or(10).max(1))
        } else {
            None
        };
        let name = clean_name(&input.name);
        let summary = summarise(&lines);
        if let Some(id) = input.id.as_deref() {
            if let Some(g) = self.groups.iter_mut().find(|g| g.id == id) {
                g.name = if name.is_empty() { g.name.clone() } else { name };
                g.lines = lines;
                g.rule = input.rule;
                g.n = n;
                g.summary = summary;
                return Ok(g.id.clone());
            }
        }
        if self.groups.len() >= MAX_GROUPS {
            return Err(format!("{MAX_GROUPS} groups is the most; remove one first"));
        }
        let id = group_id(now);
        self.groups.insert(
            0,
            Group {
                id: id.clone(),
                name: if name.is_empty() { "My group".into() } else { name },
                lines,
                rule: input.rule,
                n,
                added_at: now,
                last_used_at: 0,
                uses: 0,
                summary,
            },
        );
        Ok(id)
    }

    /// Forget a group, and the pick when it was this one.
    pub fn forget_group(&mut self, id: &str) -> bool {
        let before = self.groups.len();
        self.groups.retain(|g| g.id != id);
        if matches!(&self.picked, Some(Place::Group { id: picked }) if picked == id) {
            self.picked = None;
        }
        self.groups.len() != before
    }

    /// A connection went through group `id`: count it and bring it to the top.
    pub fn group_used(&mut self, id: &str, now: u64) {
        if let Some(at) = self.groups.iter().position(|g| g.id == id) {
            let mut g = self.groups.remove(at);
            g.uses += 1;
            g.last_used_at = now;
            self.groups.insert(0, g);
        }
    }

    /// Pick the place the switch connects to. A proxy or group that is not in
    /// the library is refused rather than remembered.
    pub fn pick(&mut self, place: Option<Place>) -> Result<(), String> {
        match &place {
            Some(Place::Proxy { id }) if self.proxy(id).is_none() => {
                return Err("that proxy is not saved here any more".into())
            }
            Some(Place::Group { id }) if self.group(id).is_none() => {
                return Err("that group is not here any more".into())
            }
            _ => {}
        }
        self.picked = place;
        Ok(())
    }

    /// Move the window's old storage in, once. Its proxies keep their names,
    /// counts and last checks, in its order; its groups their ids and rules;
    /// its pick becomes the library's. A line it kept that the engine cannot
    /// read is moved too, so it can be seen and removed rather than lost.
    /// Returns whether anything was moved (false when it had happened before).
    pub fn move_from_window(&mut self, old: WindowStorage, now: u64) -> bool {
        if self.moved_from_window {
            return false;
        }
        self.moved_from_window = true;
        let mut known: HashSet<String> = self.proxies.iter().map(|p| p.id.clone()).collect();
        for p in old.saved {
            if self.proxies.len() >= MAX_PROXIES {
                break;
            }
            let line = p.line.trim().trim_start_matches('\u{feff}').to_string();
            let id = proxy_id(&line);
            if line.is_empty() || !known.insert(id.clone()) {
                continue;
            }
            let name = p.name.as_deref().map(clean_name).filter(|n| !n.is_empty());
            self.proxies.push(Proxy {
                id,
                line,
                name,
                added_at: p.added_at,
                last_used_at: p.last_used_at,
                uses: p.uses,
                last: p.last,
            });
        }
        for l in old.lists {
            if self.groups.iter().any(|g| g.id == l.id) || self.groups.len() >= MAX_GROUPS {
                continue;
            }
            let lines = clean_lines(&l.lines, MAX_GROUP_LINES);
            if lines.is_empty() {
                continue;
            }
            let rule = l
                .rule
                .and_then(|r| serde_json::from_value::<Rule>(serde_json::Value::String(r)).ok())
                .unwrap_or(Rule::OnFailure);
            let summary = summarise(&lines);
            let name = l.name.as_deref().map(clean_name).filter(|n| !n.is_empty());
            self.groups.push(Group {
                id: l.id,
                name: name.unwrap_or_else(|| "My group".into()),
                lines,
                rule,
                n: if rule.takes_n() {
                    Some(l.n.unwrap_or(10).max(1))
                } else {
                    None
                },
                added_at: l.added_at,
                last_used_at: l.last_used_at,
                uses: l.uses,
                summary,
            });
        }
        self.picked = match old.target {
            Some(WindowTarget::Fixed { line }) => {
                let id = self.add_proxies(&[line], now).into_iter().next();
                id.map(|id| Place::Proxy { id })
            }
            Some(WindowTarget::List { id }) => self.group(&id).map(|g| Place::Group { id: g.id.clone() }),
            Some(WindowTarget::Free {
                country,
                socks5,
                exit,
                exit_country,
            }) => Some(Place::Free {
                country,
                socks5,
                exit,
                exit_country,
            }),
            None => self.picked.take(),
        };
        true
    }

    /// The whole library as a screen sees it: never a password.
    pub fn view(&self) -> LibraryView {
        LibraryView {
            proxies: self
                .proxies
                .iter()
                .map(|p| {
                    let shown = read_line(&p.line).unwrap_or_else(Shown::unreadable);
                    ProxyView {
                        id: p.id.clone(),
                        name: p.name.clone(),
                        address: shown.address,
                        user: shown.user,
                        scheme: shown.scheme,
                        about: shown.about,
                        added_at: p.added_at,
                        last_used_at: p.last_used_at,
                        uses: p.uses,
                        last: p.last.clone(),
                    }
                })
                .collect(),
            groups: self
                .groups
                .iter()
                .map(|g| GroupView {
                    id: g.id.clone(),
                    name: g.name.clone(),
                    size: g.lines.len(),
                    rule: g.rule,
                    n: g.n,
                    added_at: g.added_at,
                    last_used_at: g.last_used_at,
                    uses: g.uses,
                    summary: g.summary.clone(),
                })
                .collect(),
            picked: self.picked.clone(),
        }
    }

    /// A group's members as a screen sees them, `from` and up to `count` of
    /// them: never a password.
    pub fn members(&self, id: &str, from: usize, count: usize) -> Option<Vec<MemberView>> {
        let g = self.group(id)?;
        Some(
            g.lines
                .iter()
                .enumerate()
                .skip(from)
                .take(count)
                .map(|(index, line)| {
                    let shown = read_line(line).unwrap_or_else(Shown::unreadable);
                    MemberView {
                        index,
                        address: shown.address,
                        user: shown.user,
                        about: shown.about,
                    }
                })
                .collect(),
        )
    }

    /// A saved proxy or group, found by what a person or an assistant calls
    /// it: its id; else its name; else, for a proxy without one, what it is
    /// called instead (its session, "Session 7f3a" or "7f3a", or its address).
    /// Letters in any case. A word that fits more than one place is refused,
    /// with the ones it fits, so a connection never goes through a place
    /// nobody meant.
    pub fn find(&self, wanted: &str) -> Result<Place, String> {
        let w = wanted.trim();
        if w.is_empty() {
            return Err("say which saved proxy or group: its name or its id".into());
        }
        if let Some(p) = self.proxy(w) {
            return Ok(Place::Proxy { id: p.id.clone() });
        }
        if let Some(g) = self.group(w) {
            return Ok(Place::Group { id: g.id.clone() });
        }
        let fold = w.to_lowercase();
        let same = |s: &str| s.trim().to_lowercase() == fold;
        let view = self.view();
        let mut found: Vec<(Place, String)> = view
            .proxies
            .iter()
            .filter(|p| p.name.as_deref().is_some_and(same))
            .map(|p| (Place::Proxy { id: p.id.clone() }, p.title()))
            .chain(
                view.groups
                    .iter()
                    .filter(|g| same(&g.name))
                    .map(|g| (Place::Group { id: g.id.clone() }, g.name.clone())),
            )
            .collect();
        if found.is_empty() {
            let session = |p: &ProxyView| p.about.as_ref().and_then(|t| t.session.clone());
            found = view
                .proxies
                .iter()
                .filter(|p| same(&p.title()) || same(&p.address) || session(p).is_some_and(|s| same(&s)))
                .map(|p| (Place::Proxy { id: p.id.clone() }, p.title()))
                .collect();
        }
        match found.len() {
            0 => Err(format!("nothing saved is called \"{w}\"")),
            1 => Ok(found.remove(0).0),
            n => {
                let named: Vec<String> = found
                    .iter()
                    .take(5)
                    .map(|(place, title)| {
                        let id = match place {
                            Place::Proxy { id } | Place::Group { id } => id.as_str(),
                            Place::Free { .. } => "",
                        };
                        format!("\"{title}\" ({id})")
                    })
                    .collect();
                let more = if n > 5 {
                    format!(" and {} more", n - 5)
                } else {
                    String::new()
                };
                Err(format!(
                    "{n} saved places are called \"{w}\": {}{more}. Use the id of the one you mean.",
                    named.join(", ")
                ))
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: &str = "198.51.100.1:8080:alice:pw1";
    const B: &str = "198.51.100.2:8080:bob:pw2";

    fn lines(v: &[&str]) -> Vec<String> {
        v.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn the_id_is_the_one_the_window_computed() {
        // FNV-1a over UTF-16, base 36, exactly as desktop-app/src/lib/saved.ts did:
        // the expected values come from that function, run in Node.
        assert_eq!(proxy_id(""), "ztntfp", "the FNV offset basis, 2166136261, in base 36");
        assert_eq!(proxy_id("a:1"), "1oywwh5");
        assert_eq!(proxy_id(A), "5b6m1f");
        assert_eq!(
            proxy_id("gate.example.com:10000:acct-session-ü€:pw"),
            "10on7jm",
            "UTF-16, not bytes"
        );
        assert_eq!(proxy_id("  a:1  "), proxy_id("a:1"), "trimmed first");
    }

    #[test]
    fn adding_puts_new_lines_on_top_in_order_and_keeps_old_ones_in_place() {
        let mut lib = Library::default();
        lib.add_proxies(&lines(&[A]), 1);
        let ids = lib.add_proxies(&lines(&[B, A, "not a proxy", "", B]), 2);
        assert_eq!(ids.len(), 2, "two readable, distinct lines");
        let order: Vec<&str> = lib.proxies.iter().map(|p| p.line.as_str()).collect();
        assert_eq!(order, [B, A]);
    }

    #[test]
    fn a_use_counts_and_comes_to_the_top() {
        let mut lib = Library::default();
        lib.add_proxies(&lines(&[A, B]), 1);
        let b = proxy_id(B);
        lib.proxy_used(&b, 9);
        assert_eq!(lib.proxies[0].id, b);
        assert_eq!((lib.proxies[0].uses, lib.proxies[0].last_used_at), (1, 9));
    }

    #[test]
    fn a_view_never_carries_a_password() {
        let mut lib = Library::default();
        lib.add_proxies(
            &lines(&["gate.example.com:10000:acct-country-us-session-7f3a-lifetime-30:hunter2"]),
            1,
        );
        let json = serde_json::to_string(&lib.view()).unwrap();
        assert!(!json.contains("hunter2"), "{json}");
        let v = &lib.view().proxies[0];
        assert_eq!(v.address, "gate.example.com:10000");
        assert_eq!(v.about.as_ref().and_then(|t| t.session.as_deref()), Some("7f3a"));
    }

    #[test]
    fn forgetting_the_picked_place_forgets_the_pick() {
        let mut lib = Library::default();
        let id = lib.add_proxies(&lines(&[A]), 1).remove(0);
        lib.pick(Some(Place::Proxy { id: id.clone() })).unwrap();
        assert!(lib.forget_proxy(&id));
        assert_eq!(lib.picked, None);
        assert!(
            lib.pick(Some(Place::Proxy { id })).is_err(),
            "a gone proxy is not remembered"
        );
    }

    #[test]
    fn a_group_keeps_readable_lines_and_says_what_its_members_share() {
        let mut lib = Library::default();
        let members: Vec<String> = (0..3)
            .map(|i| {
                format!(
                    "gate.example.com:{}:acct-country-us-state-california-session-s{i}-lifetime-30:pw",
                    10000 + i
                )
            })
            .chain(["garbage".to_string()])
            .collect();
        let id = lib
            .save_group(
                GroupInput {
                    id: None,
                    name: "  US   sessions ".into(),
                    lines: members,
                    rule: Rule::OnFailure,
                    n: Some(5),
                },
                1,
            )
            .unwrap();
        let g = lib.group(&id).unwrap();
        assert_eq!(g.lines.len(), 3);
        assert_eq!(g.name, "US sessions");
        assert_eq!(g.n, None, "a rule without a number keeps none");
        assert_eq!(g.summary.sessions, 3);
        assert_eq!(g.summary.shared.region.as_deref(), Some("california"));
        assert_eq!(g.summary.shared.minutes, Some(30));
        assert_eq!(g.summary.shared.session, None);

        let m = lib.members(&id, 1, 10).unwrap();
        assert_eq!(m.len(), 2);
        assert_eq!(m[0].index, 1);
        assert_eq!(m[0].about.as_ref().and_then(|t| t.session.as_deref()), Some("s1"));
    }

    #[test]
    fn saving_a_group_again_replaces_it_and_an_empty_one_is_refused() {
        let mut lib = Library::default();
        let input = |id: Option<String>, l: &[&str]| GroupInput {
            id,
            name: "G".into(),
            lines: lines(l),
            rule: Rule::EveryMinutes,
            n: None,
        };
        let id = lib.save_group(input(None, &[A]), 1).unwrap();
        assert_eq!(lib.group(&id).unwrap().n, Some(10), "every N minutes without N is ten");
        lib.save_group(input(Some(id.clone()), &[A, B]), 2).unwrap();
        assert_eq!(lib.groups.len(), 1);
        assert_eq!(lib.group(&id).unwrap().lines.len(), 2);
        assert!(lib.save_group(input(None, &["nope"]), 3).is_err());
    }

    #[test]
    fn a_group_takes_a_new_name_but_never_an_empty_one() {
        let mut lib = Library::default();
        let id = lib
            .save_group(
                GroupInput {
                    id: None,
                    name: "Residential · Germany".into(),
                    lines: lines(&[A, B]),
                    rule: Rule::EveryMinutes,
                    n: None,
                },
                1,
            )
            .unwrap();
        assert!(lib.rename_group(&id, "  Shop   accounts "));
        assert_eq!(lib.group(&id).unwrap().name, "Shop accounts");
        assert!(!lib.rename_group(&id, "   "), "a group always has a name");
        assert_eq!(lib.group(&id).unwrap().name, "Shop accounts");
        assert!(!lib.rename_group("gone", "X"));
    }

    #[test]
    fn the_window_storage_moves_in_once_with_everything_it_had() {
        let old: WindowStorage = serde_json::from_value(serde_json::json!({
            "saved": [
                { "id": "abc", "line": A, "name": "Work", "addedAt": 5, "lastUsedAt": 7, "uses": 3,
                  "last": { "ok": true, "latencyMs": 120, "cc": "de", "place": "Berlin, Germany", "at": 6 } },
                { "id": "def", "line": B, "name": 42, "last": { "ok": "maybe" } },
                { "name": "no line" },
                "not even an object",
                { "line": format!("  {A}  ") }
            ],
            "lists": [
                { "id": "l1", "name": "Mine", "lines": [A, B, " ", 7], "rule": "every_n", "n": 4,
                  "addedAt": 1, "lastUsedAt": 2, "uses": 1 },
                { "id": "l2", "name": "Odd rule", "lines": [B], "rule": "sometimes" },
                { "name": "no id", "lines": [A] }
            ],
            "target": { "kind": "list", "id": "l1" }
        }))
        .unwrap();
        let mut lib = Library::default();
        assert!(lib.move_from_window(old.clone(), 10));
        assert_eq!(lib.proxies.len(), 2, "damaged entries stay behind, a repeat moves once");
        assert_eq!(
            lib.proxies[0].id,
            proxy_id(A),
            "every line gets its own id, not the window's"
        );
        assert_eq!(lib.proxies[0].name.as_deref(), Some("Work"));
        assert_eq!(lib.proxies[0].last.as_ref().and_then(|v| v.latency_ms), Some(120));
        assert_eq!(
            (lib.proxies[1].line.as_str(), &lib.proxies[1].name, &lib.proxies[1].last),
            (B, &None, &None),
            "a name or a check that does not read is dropped, the proxy kept"
        );
        assert_eq!(lib.groups.len(), 2);
        assert_eq!(lib.groups[0].rule, Rule::EveryN);
        assert_eq!(lib.groups[0].n, Some(4));
        assert_eq!(lib.groups[0].lines, lines(&[A, B]));
        assert_eq!(
            lib.groups[1].rule,
            Rule::OnFailure,
            "an unknown rule keeps the group, on the safe rule"
        );
        assert_eq!(lib.picked, Some(Place::Group { id: "l1".into() }));

        assert!(!lib.move_from_window(old, 11), "never twice");
        assert_eq!(lib.proxies.len(), 2);
        assert_eq!(
            lib.add_proxies(&lines(&[A]), 12),
            vec![proxy_id(A)],
            "a moved line pasted again is found"
        );
        assert_eq!(lib.proxies.len(), 2, "and never saved twice");
    }

    #[test]
    fn past_the_ceiling_new_lines_are_left_out_and_so_are_their_ids() {
        let line = |i: usize| format!("198.51.100.7:{}", i + 1);
        let mut lib = Library::default();
        let first: Vec<String> = (0..MAX_PROXIES - 2).map(line).collect();
        lib.add_proxies(&first, 1);
        let more: Vec<String> = (MAX_PROXIES - 2..MAX_PROXIES + 3)
            .map(line)
            .chain([first[0].clone()])
            .collect();
        let ids = lib.add_proxies(&more, 2);
        assert_eq!(lib.proxies.len(), MAX_PROXIES);
        assert_eq!(
            ids,
            vec![proxy_id(&more[0]), proxy_id(&more[1]), proxy_id(&first[0])],
            "two still fit; a line saved before answers too"
        );
    }

    #[test]
    fn a_picked_line_that_was_never_saved_is_saved_when_it_moves_in() {
        let old: WindowStorage = serde_json::from_value(serde_json::json!({
            "target": { "kind": "fixed", "line": B }
        }))
        .unwrap();
        let mut lib = Library::default();
        lib.move_from_window(old, 1);
        assert_eq!(lib.picked, Some(Place::Proxy { id: proxy_id(B) }));
        assert!(lib.proxy(&proxy_id(B)).is_some());
    }

    /// A library with a named proxy, an unnamed plain one, eight sessions on
    /// one gateway and a group: what `find` is asked about below.
    fn kept() -> (Library, String) {
        let mut lib = Library::default();
        lib.add_proxies(&lines(&[A, B]), 1);
        lib.rename_proxy(&proxy_id(A), "Shop");
        let sessions: Vec<String> = (0..8)
            .map(|i| format!("gate.example.com:10000:acct-country-us-session-s{i}-lifetime-30:pw"))
            .collect();
        lib.add_proxies(&sessions, 2);
        let group = lib
            .save_group(
                GroupInput {
                    id: None,
                    name: "US sessions".into(),
                    lines: sessions,
                    rule: Rule::OnFailure,
                    n: None,
                },
                3,
            )
            .unwrap();
        (lib, group)
    }

    #[test]
    fn a_title_is_the_name_then_the_session_then_the_address() {
        let mut lib = Library::default();
        lib.add_proxies(
            &lines(&[
                "gate.example.com:10000:acct-session-7f3a-lifetime-30:pw",
                "198.51.100.7:8080",
            ]),
            1,
        );
        let id = lib.proxies[0].id.clone();
        lib.rename_proxy(&id, "Shop");
        assert_eq!(lib.view().proxies[0].title(), "Shop");
        lib.rename_proxy(&id, "");
        let view = lib.view();
        assert_eq!(view.proxies[0].title(), "Session 7f3a");
        assert_eq!(view.proxies[1].title(), "198.51.100.7:8080");
    }

    #[test]
    fn a_place_is_found_by_its_id_its_name_its_session_or_its_address() {
        let (lib, group) = kept();
        let proxy = |line: &str| Place::Proxy { id: proxy_id(line) };
        assert_eq!(lib.find(&proxy_id(B)), Ok(proxy(B)), "by id");
        assert_eq!(lib.find(&group), Ok(Place::Group { id: group.clone() }));
        assert_eq!(lib.find("  shop "), Ok(proxy(A)), "by name, any case");
        assert_eq!(lib.find("us SESSIONS"), Ok(Place::Group { id: group }));
        let s3 = "gate.example.com:10000:acct-country-us-session-s3-lifetime-30:pw";
        assert_eq!(lib.find("s3"), Ok(proxy(s3)), "by the session it holds");
        assert_eq!(lib.find("Session s3"), Ok(proxy(s3)), "by what it is called");
        assert_eq!(lib.find("198.51.100.2:8080"), Ok(proxy(B)), "by its address");
        assert_eq!(
            lib.find("198.51.100.1:8080"),
            Ok(proxy(A)),
            "a named one by its address too"
        );
    }

    #[test]
    fn a_word_that_fits_several_places_or_none_is_refused_in_words() {
        let (mut lib, _) = kept();
        let shared = lib.find("gate.example.com:10000").unwrap_err();
        assert!(shared.starts_with("8 saved places are called"), "{shared}");
        assert!(
            shared.contains("\"Session s0\"") && shared.contains("and 3 more"),
            "{shared}"
        );
        assert!(!shared.contains("pw"), "never a password: {shared}");
        lib.rename_proxy(&proxy_id(B), "US sessions");
        let both = lib.find("us sessions").unwrap_err();
        assert!(
            both.starts_with("2 saved places"),
            "a proxy and a group of one name: {both}"
        );
        assert_eq!(lib.find("Nowhere"), Err("nothing saved is called \"Nowhere\"".into()));
        assert!(lib.find("  ").is_err());
    }

    #[test]
    fn the_library_round_trips_and_reads_a_file_with_fields_it_does_not_know() {
        let mut lib = Library::default();
        lib.add_proxies(&lines(&[A]), 1);
        lib.pick(Some(Place::Free {
            country: "DE".into(),
            socks5: true,
            exit: Some("203.0.113.9:1080".into()),
            exit_country: Some("DE".into()),
        }))
        .unwrap();
        let mut json = serde_json::to_value(&lib).unwrap();
        json["somethingNewer"] = serde_json::json!(true);
        let back: Library = serde_json::from_value(json).unwrap();
        assert_eq!(back, lib);
    }
}
