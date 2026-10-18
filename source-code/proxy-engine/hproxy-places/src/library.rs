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

use std::collections::{HashMap, HashSet};

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
/// The longest note a proxy or a group keeps, in characters.
pub const MAX_NOTE: usize = 500;

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
    /// The last day it works, `YYYY-MM-DD`, as the person entered it: the end
    /// of their plan. Past it the proxy is shown as expired and still works.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    /// Anything they keep with it ("Shop account 3").
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
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
    /// The last day its lines work (a plan of a thousand lines ends at once),
    /// `YYYY-MM-DD`; as on a proxy.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
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

/// What a person says about a proxy or a group: its name, the last day it
/// works and a note. A field left out stays as it is; an empty one is taken
/// away (a group keeps its name).
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    #[serde(default)]
    pub name: Option<String>,
    /// `YYYY-MM-DD`.
    #[serde(default)]
    pub expires: Option<String>,
    #[serde(default)]
    pub note: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
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

/// A note the way it is kept: its lines as typed (line ends made `\n`),
/// trimmed, capped at `MAX_NOTE` characters.
pub fn clean_note(note: &str) -> String {
    let lines = note.replace("\r\n", "\n").replace('\r', "\n");
    lines
        .trim()
        .chars()
        .take(MAX_NOTE)
        .collect::<String>()
        .trim_end()
        .to_string()
}

/// A day the way it is kept, `YYYY-MM-DD`, or `None` when `day` is not one
/// day of the calendar written so (a plan ends in this century or the next,
/// so the year is 2000 to 2199).
pub fn clean_date(day: &str) -> Option<String> {
    let (y, m, d) = ymd(day.trim())?;
    Some(format!("{y:04}-{m:02}-{d:02}"))
}

fn ymd(day: &str) -> Option<(i64, u32, u32)> {
    let b = day.as_bytes();
    if b.len() != 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    if !b
        .iter()
        .enumerate()
        .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
    {
        return None;
    }
    let (y, m, d): (i64, u32, u32) = (
        day[0..4].parse().ok()?,
        day[5..7].parse().ok()?,
        day[8..10].parse().ok()?,
    );
    if !(2000..=2199).contains(&y) || !(1..=12).contains(&m) {
        return None;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let last = [31, if leap { 29 } else { 28 }, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m as usize - 1];
    (1..=last).contains(&d).then_some((y, m, d))
}

/// Days since 1970-01-01 of a day of the (proleptic Gregorian) calendar.
fn day_number(y: i64, m: u32, d: u32) -> i64 {
    // H. Hinnant's days_from_civil: a year that starts in March puts the leap day at its end.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// How many days are left until `expires`, counted from `today` (both
/// `YYYY-MM-DD`): 0 on its last day, negative once it has passed. `None` when
/// either is not a day.
pub fn days_left(expires: &str, today: &str) -> Option<i64> {
    let (ey, em, ed) = ymd(expires.trim())?;
    let (ty, tm, td) = ymd(today.trim())?;
    Some(day_number(ey, em, ed) - day_number(ty, tm, td))
}

/// A day in words: "14 Nov", with its year when that is not `today`'s
/// ("2 Jan 2027"). A day that is not one comes back as it was written.
pub fn day_words(day: &str, today: &str) -> String {
    const MONTHS: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];
    let Some((y, m, d)) = ymd(day.trim()) else {
        return day.to_string();
    };
    let month = MONTHS[m as usize - 1];
    if ymd(today.trim()).is_some_and(|(ty, _, _)| ty == y) {
        format!("{d} {month}")
    } else {
        format!("{d} {month} {y}")
    }
}

/// A field of `Details` read for keeping: `None` = leave it, `Some(None)` =
/// take it away, `Some(Some(v))` = set it.
fn wanted<T>(
    field: Option<&str>,
    clean: impl Fn(&str) -> Result<Option<T>, String>,
) -> Result<Option<Option<T>>, String> {
    match field {
        None => Ok(None),
        Some(v) if v.trim().is_empty() => Ok(Some(None)),
        Some(v) => clean(v).map(Some),
    }
}

/// The three fields of `Details`, checked once for any number of places.
type Described = (Option<Option<String>>, Option<Option<String>>, Option<Option<String>>);

fn read_details(details: &Details) -> Result<Described, String> {
    let name = wanted(details.name.as_deref(), |v| {
        Ok(Some(clean_name(v)).filter(|n| !n.is_empty()))
    })?;
    let expires = wanted(details.expires.as_deref(), |v| {
        clean_date(v)
            .map(Some)
            .ok_or_else(|| format!("\"{}\" is not a day: write it like 2026-11-14", v.trim()))
    })?;
    let note = wanted(details.note.as_deref(), |v| {
        Ok(Some(clean_note(v)).filter(|n| !n.is_empty()))
    })?;
    Ok((name, expires, note))
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
                    expires: None,
                    note: None,
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

    /// Name several saved proxies at once, each its own name: a paste named "Shop 1", "Shop 2" …
    /// in one change. `named` pairs an id with its name; an empty name takes it away. Returns
    /// how many of them are saved.
    pub fn name_proxies(&mut self, named: &[(String, String)]) -> usize {
        let wanted: HashMap<&str, String> = named.iter().map(|(id, name)| (id.as_str(), clean_name(name))).collect();
        let mut found = 0;
        for p in self.proxies.iter_mut() {
            if let Some(name) = wanted.get(p.id.as_str()) {
                p.name = (!name.is_empty()).then(|| name.clone());
                found += 1;
            }
        }
        found
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

    /// Say what saved proxies are: one, or a whole paste at once (`ids`). A
    /// field of `details` left out stays as it is, an empty one is taken
    /// away. A date that is not a day changes nothing and says why. Returns
    /// how many of `ids` are saved.
    pub fn describe_proxies(&mut self, ids: &[String], details: &Details) -> Result<usize, String> {
        let (name, expires, note) = read_details(details)?;
        let ids: HashSet<&str> = ids.iter().map(String::as_str).collect();
        let mut found = 0;
        for p in self.proxies.iter_mut().filter(|p| ids.contains(p.id.as_str())) {
            if let Some(v) = &name {
                p.name = v.clone();
            }
            if let Some(v) = &expires {
                p.expires = v.clone();
            }
            if let Some(v) = &note {
                p.note = v.clone();
            }
            found += 1;
        }
        Ok(found)
    }

    /// The same for a group, which always keeps a name: an empty one leaves
    /// it as it is.
    pub fn describe_group(&mut self, id: &str, details: &Details) -> Result<bool, String> {
        let (name, expires, note) = read_details(details)?;
        let Some(g) = self.groups.iter_mut().find(|g| g.id == id) else {
            return Ok(false);
        };
        if let Some(Some(v)) = name {
            g.name = v;
        }
        if let Some(v) = expires {
            g.expires = v;
        }
        if let Some(v) = note {
            g.note = v;
        }
        Ok(true)
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
                expires: None,
                note: None,
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

    /// What the switch connects to, the app's big button and the tray's Connect alike
    /// (2026-10-18: "when someone wants to connect it connects to his recently connected proxy,
    /// it should have nothing to do with free proxies"): the pick, when it is one of yours and
    /// still here (a connect makes its place the pick); else the place used last; else the proxy
    /// or group added last. Never a free proxy: with none of yours, nothing, and the app asks
    /// for proxies first. desktop-app/src/lib/places.ts (`firstPlace`) says the same for the window.
    pub fn switch_place(&self) -> Option<Place> {
        match &self.picked {
            Some(Place::Proxy { id }) if self.proxy(id).is_some() => return self.picked.clone(),
            Some(Place::Group { id }) if self.group(id).is_some() => return self.picked.clone(),
            _ => {}
        }
        // The newest by `at`; on a tie the first in the list, which is the newer (lists keep
        // the newest on top).
        let newest = |places: Vec<(u64, Place)>| {
            places
                .into_iter()
                .fold(None::<(u64, Place)>, |best, (at, place)| match best {
                    Some((b, _)) if b >= at => best,
                    _ => Some((at, place)),
                })
                .map(|(_, place)| place)
        };
        let used: Vec<(u64, Place)> = self
            .proxies
            .iter()
            .filter(|p| p.uses > 0)
            .map(|p| (p.last_used_at, Place::Proxy { id: p.id.clone() }))
            .chain(
                self.groups
                    .iter()
                    .filter(|g| g.uses > 0)
                    .map(|g| (g.last_used_at, Place::Group { id: g.id.clone() })),
            )
            .collect();
        newest(used).or_else(|| {
            let added: Vec<(u64, Place)> = self
                .proxies
                .iter()
                .map(|p| (p.added_at, Place::Proxy { id: p.id.clone() }))
                .chain(
                    self.groups
                        .iter()
                        .map(|g| (g.added_at, Place::Group { id: g.id.clone() })),
                )
                .collect();
            newest(added)
        })
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
                expires: None,
                note: None,
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
                expires: None,
                note: None,
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
                        expires: p.expires.clone(),
                        note: p.note.clone(),
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
                    expires: g.expires.clone(),
                    note: g.note.clone(),
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
    fn a_paste_is_named_each_its_own_in_one_change() {
        let mut lib = Library::default();
        lib.add_proxies(&lines(&[A, B]), 1);
        let (a, b) = (proxy_id(A), proxy_id(B));
        let named = [
            (a.clone(), "  Shop   1 ".to_string()),
            (b.clone(), "Shop 2".to_string()),
            ("gone".to_string(), "Shop 3".to_string()),
        ];
        assert_eq!(lib.name_proxies(&named), 2, "the one not saved is left out");
        assert_eq!(
            lib.proxy(&a).and_then(|p| p.name.as_deref()),
            Some("Shop 1"),
            "cleaned as any name"
        );
        assert_eq!(lib.proxy(&b).and_then(|p| p.name.as_deref()), Some("Shop 2"));
        lib.name_proxies(&[(a.clone(), " ".to_string())]);
        assert_eq!(
            lib.proxy(&a).and_then(|p| p.name.as_deref()),
            None,
            "an empty name takes it away"
        );
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
    fn the_switch_connects_the_place_used_last_never_a_free_one() {
        let mut lib = Library::default();
        assert_eq!(lib.switch_place(), None, "nothing of yours: nothing");
        lib.add_proxies(&lines(&[A]), 1);
        lib.add_proxies(&lines(&[B, "198.51.100.3:8080"]), 2);
        let (a, b) = (proxy_id(A), proxy_id(B));
        let proxy = |id: &str| Some(Place::Proxy { id: id.to_string() });
        assert_eq!(
            lib.switch_place(),
            proxy(&b),
            "none used yet: the first of the batch added last"
        );
        lib.proxy_used(&a, 5);
        assert_eq!(lib.switch_place(), proxy(&a), "the one used last");
        let free = Place::Free {
            country: String::new(),
            socks5: false,
            exit: None,
            exit_country: None,
        };
        lib.pick(Some(free)).unwrap();
        assert_eq!(lib.switch_place(), proxy(&a), "a free pick is passed over");
        let g = lib
            .save_group(
                GroupInput {
                    id: None,
                    name: "G".into(),
                    lines: lines(&[B]),
                    rule: Rule::OnFailure,
                    n: None,
                },
                6,
            )
            .unwrap();
        lib.group_used(&g, 7);
        assert_eq!(
            lib.switch_place(),
            Some(Place::Group { id: g.clone() }),
            "a group used later wins"
        );
        lib.pick(proxy(&b)).unwrap();
        assert_eq!(lib.switch_place(), proxy(&b), "the pick, one of yours, comes first");
        lib.forget_proxy(&b);
        assert_eq!(
            lib.switch_place(),
            Some(Place::Group { id: g }),
            "a pick that is gone is passed over"
        );
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
    fn a_date_is_one_day_of_the_calendar_written_year_month_day() {
        assert_eq!(clean_date("2026-11-14"), Some("2026-11-14".into()));
        assert_eq!(
            clean_date(" 2028-02-29 "),
            Some("2028-02-29".into()),
            "a leap year's 29 February"
        );
        assert_eq!(clean_date("2026-02-29"), None, "2026 is no leap year");
        assert_eq!(
            clean_date("2100-02-29"),
            None,
            "a century is a leap year only every 400 years"
        );
        assert_eq!(clean_date("2000-02-29"), Some("2000-02-29".into()));
        for wrong in [
            "2026-13-01",
            "2026-04-31",
            "2026-00-10",
            "14.11.2026",
            "2026-1-14",
            "2026/11/14",
            "+202-11-14",
            "1999-12-31",
            "",
        ] {
            assert_eq!(clean_date(wrong), None, "{wrong}");
        }
    }

    #[test]
    fn days_left_count_calendar_days_and_go_below_zero_once_past() {
        assert_eq!(days_left("2026-11-14", "2026-11-14"), Some(0), "its last day");
        assert_eq!(days_left("2026-11-14", "2026-11-11"), Some(3));
        assert_eq!(days_left("2026-11-14", "2026-11-16"), Some(-2));
        assert_eq!(days_left("2027-01-02", "2026-12-30"), Some(3), "across a new year");
        assert_eq!(days_left("2028-03-01", "2028-02-28"), Some(2), "across a leap day");
        assert_eq!(days_left("2026-03-01", "2026-02-28"), Some(1));
        assert_eq!(days_left("2026-11-14", "someday"), None);
    }

    #[test]
    fn many_proxies_take_a_date_and_a_note_at_once_and_a_field_left_out_stays() {
        let mut lib = Library::default();
        let c = "198.51.100.3:8080";
        let ids = lib.add_proxies(&lines(&[A, B, c]), 1);
        let both = vec![ids[0].clone(), ids[1].clone(), "not-saved".to_string()];
        let set = Details {
            name: None,
            expires: Some("2026-11-14".into()),
            note: Some("  Shop batch\r\nfrom October  ".into()),
        };
        assert_eq!(lib.describe_proxies(&both, &set), Ok(2), "only saved ids count");
        let p = lib.proxy(&ids[0]).unwrap();
        assert_eq!(
            (p.expires.as_deref(), p.note.as_deref()),
            (Some("2026-11-14"), Some("Shop batch\nfrom October"))
        );
        assert_eq!(
            lib.proxy(&ids[2]).unwrap().expires,
            None,
            "a proxy not named keeps nothing"
        );

        // Only the note goes; the date stays; a name is given to one of them.
        let clear = Details {
            name: Some("Shop 1".into()),
            expires: None,
            note: Some(" ".into()),
        };
        assert_eq!(lib.describe_proxies(&ids[..1], &clear), Ok(1));
        let p = lib.proxy(&ids[0]).unwrap();
        assert_eq!(
            (p.name.as_deref(), p.expires.as_deref(), p.note.as_deref()),
            (Some("Shop 1"), Some("2026-11-14"), None)
        );

        // A date that is not a day changes nothing at all.
        let wrong = Details {
            name: Some("Changed".into()),
            expires: Some("2026-02-30".into()),
            note: None,
        };
        assert!(lib.describe_proxies(&ids, &wrong).unwrap_err().contains("2026-02-30"));
        assert_eq!(lib.proxy(&ids[0]).unwrap().name.as_deref(), Some("Shop 1"));

        // A note is kept up to MAX_NOTE characters; the view carries both; the file keeps both.
        let long = Details {
            note: Some("x".repeat(MAX_NOTE + 40)),
            ..Details::default()
        };
        lib.describe_proxies(&ids[1..2], &long).unwrap();
        let view = lib.view();
        let shown = view.proxies.iter().find(|v| v.id == ids[1]).unwrap();
        assert_eq!(shown.note.as_ref().map(|n| n.chars().count()), Some(MAX_NOTE));
        assert_eq!(shown.expires.as_deref(), Some("2026-11-14"));
        let back: Library = serde_json::from_value(serde_json::to_value(&lib).unwrap()).unwrap();
        assert_eq!(back, lib);
    }

    #[test]
    fn a_group_takes_a_date_and_a_note_and_keeps_its_name() {
        let mut lib = Library::default();
        let id = lib
            .save_group(
                GroupInput {
                    id: None,
                    name: "Shop batch".into(),
                    lines: lines(&[A, B]),
                    rule: Rule::OnFailure,
                    n: None,
                },
                1,
            )
            .unwrap();
        let d = Details {
            name: Some(" ".into()),
            expires: Some("2026-12-01".into()),
            note: Some("300 lines".into()),
        };
        assert_eq!(lib.describe_group(&id, &d), Ok(true));
        assert_eq!(lib.describe_group("g-none", &d), Ok(false));
        let g = &lib.view().groups[0];
        assert_eq!(
            (g.name.as_str(), g.expires.as_deref(), g.note.as_deref()),
            ("Shop batch", Some("2026-12-01"), Some("300 lines"))
        );
        // Saving the group again (new lines, a new rule) keeps what was said about it.
        lib.save_group(
            GroupInput {
                id: Some(id.clone()),
                name: "".into(),
                lines: lines(&[A]),
                rule: Rule::Random,
                n: None,
            },
            2,
        )
        .unwrap();
        assert_eq!(lib.group(&id).unwrap().expires.as_deref(), Some("2026-12-01"));
    }

    #[test]
    fn a_library_from_before_dates_and_notes_reads_without_them() {
        let old = serde_json::json!({
            "version": 1,
            "proxies": [{ "id": proxy_id(A), "line": A, "name": "Old one", "addedAt": 5, "lastUsedAt": 0, "uses": 0 }],
            "groups": [{ "id": "g1", "name": "Old group", "lines": [B], "rule": "on_failure", "addedAt": 5, "lastUsedAt": 0, "uses": 0 }],
            "movedFromWindow": true
        });
        let lib: Library = serde_json::from_value(old).unwrap();
        assert_eq!(lib.proxies[0].expires, None);
        assert_eq!(lib.groups[0].note, None);
        // A library without dates writes no empty fields for them either.
        let written = serde_json::to_string(&lib).unwrap();
        assert!(!written.contains("expires") && !written.contains("note"), "{written}");
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
