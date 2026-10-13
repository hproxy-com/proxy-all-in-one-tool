//! The phone's checker: a list of proxies checked from this phone, every
//! answer sent to the screen the moment it lands (the Flip cards turn over as
//! they come), with where each one comes out and, when the person asked,
//! whether a site (Google, Instagram, ...) opens through it.
//!
//! One run at a time; a new one ends the one before. The lines stay here, in
//! Rust: the screen gets each proxy's address, never its password, and asks
//! for the lines only when the person copies, shares or saves them.
//!
//! The last runs are kept (`RECENT`), so "Recent checks" can show how they
//! went and check the same list again with one tap. They are kept the way the
//! places are, in the app's private folder.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use hproxy_api::geo::Geo;
use hproxy_connection::sites::{self, Site, SiteVerdict};
use hproxy_places::{Library, Verdict};
use hproxy_probe::{Batch, BatchOptions, CheckOptions, CheckResult, Checker, Status, Tone, Way};
use serde::{Deserialize, Serialize};
use tokio::sync::Semaphore;

use crate::events::Events;

/// How many proxies a phone checks at once at most; the engine's governor
/// goes lower on its own when the network shows strain.
const AT_ONCE: usize = 32;
/// Site checks at once (each one is a page head through a working proxy).
const SITES_AT_ONCE: usize = 8;
/// Answers worked on at once (located, asked about a site, sent).
const ROWS_AT_ONCE: usize = 16;
/// Runs kept for "Recent checks".
const RECENT: usize = 10;
/// The most lines one run takes.
const MOST: usize = 20_000;

static NEXT_RUN: AtomicU64 = AtomicU64::new(1);

/// What a run checks.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StartInput {
    /// Pasted text, one proxy a line.
    #[serde(default)]
    pub text: Option<String>,
    /// A saved group, by its id.
    #[serde(default)]
    pub group: Option<String>,
    /// Every saved proxy.
    #[serde(default)]
    pub saved: bool,
    /// A run from "Recent checks", by its id.
    #[serde(default)]
    pub again: Option<u64>,
    #[serde(default)]
    pub site: Option<Site>,
    /// Who judges the run: the checker's one choice since 2026-10-11 (a check
    /// is a check; only the judge can change).
    #[serde(default)]
    pub judge: JudgeChoice,
    /// Saved proxies, by id: the ones just added, checked at once so their
    /// rows show where they are, how fast, and that they work.
    #[serde(default)]
    pub ids: Vec<String>,
    /// A check beside the checker's own run (the Proxies screen's "Just
    /// added"): it never replaces or stops the run on the Checker tab and is
    /// not kept among the recent checks. Its answers are saved with the
    /// proxies, as every check of saved proxies is.
    #[serde(default)]
    pub quiet: bool,
}

/// The judge every proxy of a run is asked to open: HProxy's own (an echo
/// that grades anonymity, with Cloudflare's trace on our zone as the next
/// rung), Cloudflare's trace on its own domain, or an address of the
/// person's own (`hproxy_probe::Ladder::custom`).
#[derive(Debug, Deserialize, Clone, Default, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum JudgeChoice {
    #[default]
    Hproxy,
    Cloudflare,
    Own {
        url: String,
    },
}

impl JudgeChoice {
    /// The checker for a run judged this way; HProxy's is the shared one.
    fn checker(&self, shared: &Arc<Checker>) -> Result<Arc<Checker>, String> {
        Ok(match self {
            JudgeChoice::Hproxy => Arc::clone(shared),
            JudgeChoice::Cloudflare => Arc::new(Checker::new(hproxy_probe::Ladder::cloudflare())),
            JudgeChoice::Own { url } => Arc::new(Checker::new(
                hproxy_probe::Ladder::custom(url)
                    .ok_or("that judge's address cannot be read: it starts with http:// or https://")?,
            )),
        })
    }
}

/// One proxy of the run, as the screen draws its card before the answer.
#[derive(Debug, Serialize, Clone)]
pub struct Item {
    pub i: usize,
    /// `host:port`, never the login.
    pub address: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Started {
    pub run: u64,
    pub items: Vec<Item>,
    /// Lines that are not proxies.
    pub invalid: usize,
    /// Lines that repeat one already in the run.
    pub repeated: usize,
    pub site: Site,
}

/// One answer, as a card shows it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub i: usize,
    pub alive: bool,
    /// It carries a connection (https sites and apps).
    pub carries: bool,
    pub tone: Tone,
    /// A few words: "Working · 180 ms", "Can't open https sites".
    pub says: String,
    /// One sentence when it is not simply working.
    pub why: Option<String>,
    /// What the engine found, as stable words: "slow", "plain_http_only", ...
    pub notes: Vec<String>,
    pub ms: Option<i32>,
    pub way: Option<Way>,
    pub exit_ip: Option<String>,
    /// Lower case, for the flag.
    pub cc: Option<String>,
    pub country: Option<String>,
    pub city: Option<String>,
    pub datacenter: Option<bool>,
    pub anonymity: Option<String>,
    pub protocols: Vec<String>,
    /// Why it never answered, when it did not.
    pub error: Option<String>,
    /// The site asked, when one was.
    pub site: Option<SiteVerdict>,
}

#[derive(Debug, Serialize)]
pub struct GeoItem {
    pub i: usize,
    pub cc: String,
}

/// How a run went, for "Recent checks".
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Summary {
    pub id: u64,
    pub at: u64,
    pub total: usize,
    pub working: usize,
    pub slow: usize,
    /// Answered, but cannot be used (or the site refused it).
    pub bad: usize,
    pub dead: usize,
    pub site: Option<Site>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Kept {
    summary: Summary,
    lines: Vec<String>,
}

/// The run in progress or the last one, with its lines.
struct Run {
    id: u64,
    cancel: Arc<AtomicBool>,
    lines: Vec<String>,
}

pub struct Checks {
    current: Mutex<Option<Run>>,
    dir: PathBuf,
}

impl Checks {
    pub fn new(data: &Path) -> Checks {
        Checks {
            current: Mutex::new(None),
            dir: data.join("checks"),
        }
    }

    fn recent_path(&self) -> PathBuf {
        self.dir.join("recent.json")
    }

    fn kept(&self) -> Vec<Kept> {
        std::fs::read(self.recent_path())
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn keep(&self, run: Kept) {
        let mut all = self.kept();
        all.retain(|k| k.summary.id != run.summary.id);
        all.insert(0, run);
        all.truncate(RECENT);
        if std::fs::create_dir_all(&self.dir).is_ok() {
            let fresh = self.dir.join("recent.json.new");
            if let Ok(json) = serde_json::to_vec(&all) {
                if write_private(&fresh, &json).is_ok() {
                    let _ = std::fs::rename(&fresh, self.recent_path());
                }
            }
        }
    }

    /// "Recent checks": how each went, newest first.
    pub fn recent(&self) -> Vec<Summary> {
        self.kept().into_iter().map(|k| k.summary).collect()
    }

    /// Lines of the current run, by their place in it, for copying,
    /// sharing or saving (the person asked).
    pub fn lines(&self, run: u64, which: &[usize]) -> Result<Vec<String>, String> {
        let guard = self.current.lock().unwrap_or_else(|e| e.into_inner());
        let r = guard
            .as_ref()
            .filter(|r| r.id == run)
            .ok_or("that check is not the one on the screen any more")?;
        Ok(which.iter().filter_map(|i| r.lines.get(*i).cloned()).collect())
    }

    pub fn cancel(&self) {
        if let Some(r) = self.current.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            r.cancel.store(true, Ordering::SeqCst);
        }
    }
}

/// What is done with the answers of saved proxies: (proxy id, its answer).
pub type OnSaved = Box<dyn Fn(Vec<(String, Verdict)>) + Send + Sync>;

/// What a run needs from the engine.
pub struct Tools {
    pub checker: Arc<Checker>,
    pub geo: Arc<Geo>,
    pub events: Arc<Events>,
    /// Saved proxies checked by the run get their answer kept on them.
    pub on_saved: OnSaved,
}

/// Start a run (it goes on in the background) and say what it checks.
pub fn start(checks: &Arc<Checks>, lib: &Library, input: StartInput, tools: Tools) -> Result<Started, String> {
    let site = input.site.unwrap_or(Site::Any);
    let checker = input.judge.checker(&tools.checker)?;
    let (raw, saved_ids): (Vec<String>, HashMap<String, String>) = if let Some(text) = input.text {
        (text.lines().map(str::to_string).collect(), HashMap::new())
    } else if let Some(id) = input.group {
        let g = lib.group(&id).ok_or("that group is not here any more")?;
        (g.lines.clone(), HashMap::new())
    } else if input.saved || !input.ids.is_empty() {
        let chosen: Vec<_> = lib
            .proxies
            .iter()
            .filter(|p| input.ids.is_empty() || input.ids.contains(&p.id))
            .collect();
        let lines = chosen.iter().map(|p| p.line.clone()).collect();
        let ids = chosen
            .iter()
            .map(|p| (p.line.trim().to_string(), p.id.clone()))
            .collect();
        (lines, ids)
    } else if let Some(id) = input.again {
        let kept = checks
            .kept()
            .into_iter()
            .find(|k| k.summary.id == id)
            .ok_or("that check is no longer kept")?;
        (kept.lines, HashMap::new())
    } else {
        return Err("nothing to check".into());
    };
    let raw: Vec<String> = raw
        .into_iter()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .take(MOST)
        .collect();
    let given = raw.len();

    let opts = BatchOptions {
        concurrency: AT_ONCE,
        check: CheckOptions::default(),
        dedupe: true,
    };
    let batch = Batch::new(raw, checker, opts);
    let invalid = batch.invalid();
    let repeated = given.saturating_sub(batch.len());
    let mut lines = Vec::new();
    let mut items = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut hosts: HashMap<String, Vec<usize>> = HashMap::new();
    for item in batch.items().iter() {
        if let Ok(l) = &item.line {
            let i = lines.len();
            index.insert(item.raw.clone(), i);
            hosts.entry(l.host.clone()).or_default().push(i);
            items.push(Item { i, address: l.addr() });
            lines.push(item.raw.clone());
        }
    }
    if items.is_empty() {
        return Err("none of the lines can be read as a proxy".into());
    }

    let id = NEXT_RUN.fetch_add(1, Ordering::SeqCst);
    let cancel = batch.cancel_handle();
    let quiet = input.quiet;
    if !quiet {
        let mut current = checks.current.lock().unwrap_or_else(|e| e.into_inner());
        if let Some(old) = current.replace(Run {
            id,
            cancel: cancel.clone(),
            lines: lines.clone(),
        }) {
            old.cancel.store(true, Ordering::SeqCst);
        }
    }

    let started = Started {
        run: id,
        items,
        invalid,
        repeated,
        site,
    };
    let checks = Arc::clone(checks);
    tokio::spawn(run(
        id, batch, lines, index, hosts, saved_ids, site, cancel, checks, tools, quiet,
    ));
    Ok(started)
}

#[allow(clippy::too_many_arguments)]
async fn run(
    id: u64,
    batch: Batch,
    lines: Vec<String>,
    index: HashMap<String, usize>,
    hosts: HashMap<String, Vec<usize>>,
    saved_ids: HashMap<String, String>,
    site: Site,
    cancel: Arc<AtomicBool>,
    checks: Arc<Checks>,
    tools: Tools,
    quiet: bool,
) {
    let began = Instant::now();
    let Tools {
        checker: _,
        geo,
        events,
        on_saved,
    } = tools;

    // The flags on the cards face down: where each proxy's own address is,
    // looked up beside the run, never in front of it.
    let geo_task = {
        let geo = Arc::clone(&geo);
        let events = Arc::clone(&events);
        let cancel = Arc::clone(&cancel);
        let names: Vec<String> = hosts.keys().cloned().collect();
        tokio::spawn(async move {
            geo.prefetch(&names, |labels| {
                if cancel.load(Ordering::SeqCst) {
                    return;
                }
                let items: Vec<GeoItem> = labels
                    .iter()
                    .filter_map(|l| Some((hosts.get(&l.ip)?, l.country_code.as_ref()?)))
                    .flat_map(|(is, cc)| {
                        is.iter().map(move |i| GeoItem {
                            i: *i,
                            cc: cc.to_ascii_lowercase(),
                        })
                    })
                    .collect();
                if !items.is_empty() {
                    events.emit("checkGeo", serde_json::json!({ "run": id, "items": items }));
                }
            })
            .await;
        })
    };

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<CheckResult>();
    let tally = Arc::new(Mutex::new(Summary {
        id,
        at: hproxy_connection::now_ms(),
        total: lines.len(),
        site: (site != Site::Any).then_some(site),
        ..Default::default()
    }));
    let verdicts: Arc<Mutex<Vec<(String, Verdict)>>> = Arc::new(Mutex::new(Vec::new()));
    let worker = {
        let geo = Arc::clone(&geo);
        let events = Arc::clone(&events);
        let tally = Arc::clone(&tally);
        let verdicts = Arc::clone(&verdicts);
        let cancel = Arc::clone(&cancel);
        tokio::spawn(async move {
            let rows = Arc::new(Semaphore::new(ROWS_AT_ONCE));
            let sites_at_once = Arc::new(Semaphore::new(SITES_AT_ONCE));
            let index = Arc::new(index);
            let saved_ids = Arc::new(saved_ids);
            let mut tasks = Vec::new();
            while let Some(r) = rx.recv().await {
                let Ok(permit) = Arc::clone(&rows).acquire_owned().await else {
                    break;
                };
                let (geo, events, tally, verdicts, cancel, index, saved_ids, sites_at_once) = (
                    Arc::clone(&geo),
                    Arc::clone(&events),
                    Arc::clone(&tally),
                    Arc::clone(&verdicts),
                    Arc::clone(&cancel),
                    Arc::clone(&index),
                    Arc::clone(&saved_ids),
                    Arc::clone(&sites_at_once),
                );
                tasks.push(tokio::spawn(async move {
                    let _permit = permit;
                    let Some(&i) = index.get(&r.input) else { return };
                    if r.status == Status::Invalid || cancel.load(Ordering::SeqCst) {
                        return;
                    }
                    let (row, verdict) = answer(i, r, site, &geo, &sites_at_once).await;
                    if cancel.load(Ordering::SeqCst) {
                        return;
                    }
                    if let Some((line, v)) = verdict {
                        if let Some(pid) = saved_ids.get(line.trim()) {
                            verdicts
                                .lock()
                                .unwrap_or_else(|e| e.into_inner())
                                .push((pid.clone(), v));
                        }
                    }
                    count(&mut tally.lock().unwrap_or_else(|e| e.into_inner()), &row);
                    events.emit("check", serde_json::json!({ "run": id, "quiet": quiet, "row": row }));
                }));
            }
            for t in tasks {
                let _ = t.await;
            }
        })
    };

    let done = batch
        .run(|r| {
            let _ = tx.send(r);
        })
        .await;
    drop(tx);
    let _ = worker.await;
    if done.cancelled {
        geo_task.abort();
    } else {
        let _ = tokio::time::timeout(Duration::from_secs(3), geo_task).await;
    }

    let verdicts = std::mem::take(&mut *verdicts.lock().unwrap_or_else(|e| e.into_inner()));
    if !verdicts.is_empty() {
        on_saved(verdicts);
    }
    let summary = tally.lock().unwrap_or_else(|e| e.into_inner()).clone();
    if !done.cancelled && !quiet {
        checks.keep(Kept {
            summary: summary.clone(),
            lines,
        });
    }
    events.emit(
        "checkDone",
        serde_json::json!({
            "run": id,
            "quiet": quiet,
            "cancelled": done.cancelled,
            "ms": began.elapsed().as_millis() as u64,
            "summary": summary,
        }),
    );
}

/// One answer, located, read for a connector, and asked about the site.
async fn answer(
    i: usize,
    mut r: CheckResult,
    site: Site,
    geo: &Geo,
    sites_at_once: &Semaphore,
) -> (Row, Option<(String, Verdict)>) {
    // Where it comes out: the exit when it works, else the address dialled.
    if let Some(ip) = hproxy_api::geo::located_ip(&r).map(str::to_string) {
        if !geo.knows(&ip) {
            geo.prefetch(std::slice::from_ref(&ip), |_| {}).await;
        }
    }
    if let Some(host) = r.ip.clone() {
        geo.enrich(&host, &mut r);
    }
    let parsed = hproxy_probe::parse(&r.input).ok();
    if let Some(usable) = r.usable.take() {
        let asked = parsed
            .as_ref()
            .and_then(|p| p.auth.as_ref())
            .and_then(|(user, _)| hproxy_places::read_targeting(user).country);
        r.usable = Some(usable.with_asked_country(asked.as_deref(), r.country_code.as_deref()));
    }
    let usable = r.usable.clone().unwrap_or_else(|| hproxy_probe::usable(&r, None, None));
    // The relay in this process starts with what the proxy proved it speaks.
    if let (Some(way), Some(p)) = (usable.way, parsed.as_ref()) {
        hproxy_relay::upstream::remember_at(&p.addr(), way.into());
    }
    let site_verdict = match (site, usable.carries, usable.way, parsed.as_ref()) {
        (Site::Any, _, _, _) | (_, false, _, _) => None,
        (_, true, Some(way), Some(p)) => {
            let _permit = sites_at_once.acquire().await.ok();
            Some(sites::check(p, way, site).await)
        }
        _ => None,
    };
    let verdict = Verdict::of_check(&r, hproxy_connection::now_ms());
    let notes = usable
        .notes
        .iter()
        .filter_map(|n| serde_json::to_value(n).ok())
        .filter_map(|v| v.get("kind").and_then(|k| k.as_str()).map(str::to_string))
        .collect();
    let row = Row {
        i,
        alive: r.alive,
        carries: usable.carries,
        tone: usable.tone,
        says: usable.says,
        why: usable.why,
        notes,
        ms: r.latency_ms,
        way: usable.way,
        exit_ip: r.exit_ip.clone(),
        cc: r.country_code.as_deref().map(str::to_ascii_lowercase),
        country: r.country.clone(),
        city: r.city.clone(),
        datacenter: r.is_datacenter,
        anonymity: r.anonymity.clone(),
        protocols: r.protocols.clone(),
        error: r.error.clone(),
        site: site_verdict,
    };
    (row, Some((r.input, verdict)))
}

fn count(s: &mut Summary, row: &Row) {
    let refused = matches!(row.site, Some(SiteVerdict::Refuses { .. }));
    if !row.alive {
        s.dead += 1;
    } else if !row.carries || row.tone == Tone::Bad || refused {
        s.bad += 1;
    } else if row.tone == Tone::Warn {
        s.slow += 1;
    } else {
        s.working += 1;
    }
}

#[cfg(unix)]
fn write_private(path: &Path, body: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    f.write_all(body)?;
    f.sync_all()
}

#[cfg(not(unix))]
fn write_private(path: &Path, body: &[u8]) -> std::io::Result<()> {
    std::fs::write(path, body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(alive: bool, carries: bool, tone: Tone, site: Option<SiteVerdict>) -> Row {
        Row {
            i: 0,
            alive,
            carries,
            tone,
            says: String::new(),
            why: None,
            notes: Vec::new(),
            ms: None,
            way: None,
            exit_ip: None,
            cc: None,
            country: None,
            city: None,
            datacenter: None,
            anonymity: None,
            protocols: Vec::new(),
            error: None,
            site,
        }
    }

    #[test]
    fn a_run_is_tallied_the_way_the_cards_read() {
        let mut s = Summary::default();
        count(&mut s, &row(true, true, Tone::Good, None));
        count(&mut s, &row(true, true, Tone::Warn, None));
        count(&mut s, &row(true, false, Tone::Bad, None));
        count(
            &mut s,
            &row(true, true, Tone::Good, Some(SiteVerdict::Refuses { why: "x".into() })),
        );
        count(&mut s, &row(false, false, Tone::Bad, None));
        assert_eq!((s.working, s.slow, s.bad, s.dead), (1, 1, 2, 1));
    }

    #[test]
    fn recent_runs_are_kept_newest_first_and_no_more_than_ten() {
        let dir = std::env::temp_dir().join(format!("hproxy-mobile-checks-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let checks = Checks::new(&dir);
        for id in 1..=12 {
            checks.keep(Kept {
                summary: Summary {
                    id,
                    total: 1,
                    ..Default::default()
                },
                lines: vec![format!("198.51.100.{id}:8080")],
            });
        }
        let recent = checks.recent();
        assert_eq!(recent.len(), RECENT);
        assert_eq!(recent[0].id, 12);
        assert_eq!(checks.kept()[0].lines, ["198.51.100.12:8080"]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The events are read the way the app reads them, waiting on a thread of
    // their own, so the run needs threads of its own too.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_run_answers_every_proxy_and_ends_with_a_summary() {
        let dir = std::env::temp_dir().join(format!("hproxy-mobile-run-{}", std::process::id()));
        let checks = Arc::new(Checks::new(&dir));
        let events = Arc::new(Events::default());
        // Two ports where nothing listens: both are answered as dead, fast.
        let a = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let b = std::net::TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap();
        let input = StartInput {
            text: Some(format!("{a}\n{b}\n{a}\nnot a proxy\n")),
            ..Default::default()
        };
        let tools = Tools {
            checker: Arc::new(Checker::public()),
            geo: Arc::new(Geo::new("")),
            events: Arc::clone(&events),
            on_saved: Box::new(|_| {}),
        };
        let started = start(&checks, &Library::default(), input, tools).unwrap();
        assert_eq!(started.items.len(), 2, "the repeat is checked once");
        assert_eq!((started.invalid, started.repeated), (1, 1));
        let mut answered = 0;
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            assert!(Instant::now() < deadline, "the run never finished");
            let Some(e) = events.poll(Duration::from_millis(200)) else {
                continue;
            };
            let v: serde_json::Value = serde_json::from_str(&e).unwrap();
            match v["type"].as_str() {
                Some("check") => {
                    answered += 1;
                    assert_eq!(v["row"]["alive"], false);
                }
                Some("checkDone") => {
                    assert_eq!(v["summary"]["dead"], 2);
                    break;
                }
                _ => {}
            }
        }
        assert_eq!(answered, 2);
        assert_eq!(
            checks.lines(started.run, &[0, 1]).unwrap().len(),
            2,
            "the lines stay for copying"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // The Proxies screen checks what was just added beside the checker: the
    // run on the Checker tab goes on, and nothing joins the recent checks.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_quiet_check_of_chosen_saved_proxies_leaves_the_checker_alone() {
        let dir = std::env::temp_dir().join(format!("hproxy-mobile-quiet-{}", std::process::id()));
        let checks = Arc::new(Checks::new(&dir));
        let events = Arc::new(Events::default());
        let closed = || {
            std::net::TcpListener::bind("127.0.0.1:0")
                .unwrap()
                .local_addr()
                .unwrap()
                .to_string()
        };
        let (a, b, c) = (closed(), closed(), closed());
        let mut lib = Library::default();
        let ids = lib.add_proxies(&[a.clone(), b.clone(), c.clone()], 1);
        let tools = |events: &Arc<Events>, seen: Arc<Mutex<Vec<String>>>| Tools {
            checker: Arc::new(Checker::public()),
            geo: Arc::new(Geo::new("")),
            events: Arc::clone(events),
            on_saved: Box::new(move |v| {
                seen.lock().unwrap().extend(v.into_iter().map(|(id, _)| id));
            }),
        };

        // The checker's own run, then the quiet one on two saved proxies.
        let own = start(
            &checks,
            &lib,
            StartInput {
                text: Some(c.clone()),
                ..Default::default()
            },
            tools(&events, Arc::default()),
        )
        .unwrap();
        let seen: Arc<Mutex<Vec<String>>> = Arc::default();
        let quiet = start(
            &checks,
            &lib,
            StartInput {
                ids: vec![ids[0].clone(), ids[1].clone()],
                quiet: true,
                ..Default::default()
            },
            tools(&events, Arc::clone(&seen)),
        )
        .unwrap();
        assert_eq!(quiet.items.len(), 2, "only the chosen ones");

        let mut done = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(30);
        while done.len() < 2 {
            assert!(Instant::now() < deadline, "the runs never finished");
            let Some(e) = events.poll(Duration::from_millis(200)) else {
                continue;
            };
            let v: serde_json::Value = serde_json::from_str(&e).unwrap();
            if v["type"] == "checkDone" {
                done.push((v["run"].as_u64().unwrap(), v["quiet"].as_bool().unwrap()));
            }
        }
        done.sort();
        assert_eq!(done, [(own.run, false), (quiet.run, true)]);

        let mut seen = seen.lock().unwrap().clone();
        seen.sort();
        let mut want = vec![ids[0].clone(), ids[1].clone()];
        want.sort();
        assert_eq!(seen, want, "the answers are kept on the saved proxies");
        assert!(
            checks.lines(own.run, &[0]).is_ok(),
            "the checker's run is still the one shown"
        );
        assert!(checks.lines(quiet.run, &[0]).is_err());
        assert_eq!(
            checks.recent().iter().map(|s| s.id).collect::<Vec<_>>(),
            [own.run],
            "only the checker's run is kept"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
