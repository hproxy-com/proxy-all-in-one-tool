//! Usage counts (hproxy-api, `usage`): the window asks once, Settings has the
//! switch and shows the last report exactly as it went, and nothing is counted
//! or sent before a yes. The book is `usage.json` beside the places; this file
//! counts what happens in this app and sends the finished days, looking once an
//! hour. What a report holds, and why: PRIVACY.md, "Usage counts".

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use hproxy_api::usage::{self, About, Answer, Book, Event};
use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

use crate::places::PlacesState;

/// How often the finished days are looked for: a day goes the first hour after it ends that
/// the app runs, and an hour that fails (no internet) is simply tried again.
const EVERY: Duration = Duration::from_secs(60 * 60);

/// The book, kept beside the places. A library kept in memory only (no folder for the app's
/// data) keeps this in memory too: the question then comes again at the next start.
pub struct UsageState {
    book: Mutex<Book>,
    path: Option<PathBuf>,
}

/// What the window shows: the answer, and the last report exactly as it was sent.
#[derive(Serialize)]
pub struct UsageView {
    answer: Answer,
    last: Option<Value>,
}

/// Which app this is, in the server's words: this program on a phone is the phone app.
fn about() -> About<'static> {
    About {
        app: if cfg!(target_os = "android") {
            "phone"
        } else {
            "desktop"
        },
        os: usage::os_word(),
        version: env!("CARGO_PKG_VERSION"),
    }
}

/// Today on the computer's own calendar: a day is the person's day.
fn today() -> String {
    chrono::Local::now().date_naive().format("%Y-%m-%d").to_string()
}

impl UsageState {
    pub fn open(dir: Option<&Path>) -> Self {
        let path = dir.map(|d| d.join("usage.json"));
        let book = path.as_deref().map(Book::load).unwrap_or_default();
        Self {
            book: Mutex::new(book),
            path,
        }
    }

    /// Change the book and keep it.
    fn change<T>(&self, f: impl FnOnce(&mut Book) -> T) -> T {
        let mut book = self.book.lock().unwrap_or_else(|e| e.into_inner());
        let out = f(&mut book);
        if let Some(path) = &self.path {
            if let Err(e) = book.save(path) {
                log::warn!("the usage counts could not be kept: {e}");
            }
        }
        out
    }

    /// Read the book, changing nothing.
    fn read<T>(&self, f: impl FnOnce(&Book) -> T) -> T {
        f(&self.book.lock().unwrap_or_else(|e| e.into_inner()))
    }

    fn answer(&self) -> Answer {
        self.read(|b| b.answer)
    }

    fn view(&self) -> UsageView {
        self.read(|b| UsageView {
            answer: b.answer,
            last: b.last.clone(),
        })
    }

    /// Count `event` today; nothing at all, not even a write, before a yes.
    pub fn count(&self, event: &Event) {
        if self.answer() == Answer::Yes {
            self.change(|b| b.count(&today(), event));
        }
    }

    /// The same, from the panic hook: a lock someone holds is never waited for.
    fn count_now(&self, event: &Event) {
        if let Ok(mut book) = self.book.try_lock() {
            if book.answer == Answer::Yes {
                book.count(&today(), event);
                if let Some(path) = &self.path {
                    let _ = book.save(path);
                }
            }
        }
    }
}

/// Count `event`, from anywhere in the app.
pub fn count(app: &AppHandle, event: Event) {
    if let Some(usage) = app.try_state::<UsageState>() {
        usage.count(&event);
    }
}

/// A feature was used, by its fixed name (hproxy-api, `usage::FEATURES`).
pub fn feature(app: &AppHandle, name: &str) {
    count(app, Event::Feature { name: name.into() });
}

/// How many proxies and groups are kept, written on a day that already counts something.
fn kept_today(app: &AppHandle, usage: &UsageState) {
    let Some(places) = app.try_state::<PlacesState>() else {
        return;
    };
    let today = today();
    if !usage.read(|b| b.answer == Answer::Yes && b.days.contains_key(&today)) {
        return;
    }
    let (proxies, groups) = places.read(|lib| (lib.proxies.len() as u64, lib.groups.len() as u64));
    usage.change(|b| b.count(&today, &Event::Kept { proxies, groups }));
}

/// The app opened (a start, or its window brought back from the tray).
pub fn opened(app: &AppHandle) {
    let Some(usage) = app.try_state::<UsageState>() else {
        return;
    };
    usage.count(&Event::Opened);
    kept_today(app, &usage);
}

/// A crash in the engine counts too: the panic hook, which must never wait or panic itself.
pub fn count_panics(app: &AppHandle) {
    let app = app.clone();
    let before = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if let Some(usage) = app.try_state::<UsageState>() {
            usage.count_now(&Event::Crash { part: "engine".into() });
        }
        before(info);
    }));
}

/// Look for finished days once an hour, for as long as the app runs (in the tray too).
pub fn start(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        // After the start's own work: the update check and the first screens go first.
        tokio::time::sleep(Duration::from_secs(90)).await;
        let client = hproxy_api::http_client("hproxy-checker", Duration::from_secs(20));
        loop {
            send_due(&app, &client).await;
            tokio::time::sleep(EVERY).await;
        }
    });
}

async fn send_due(app: &AppHandle, client: &hproxy_api::HttpClient) {
    let Some(usage) = app.try_state::<UsageState>() else {
        return;
    };
    if usage.answer() != Answer::Yes {
        return;
    }
    kept_today(app, &usage);
    let today = today();
    let due = usage.read(|b| b.due(&today, about()));
    for (day, report) in due {
        if let Err(e) = usage::send(client, usage::DEFAULT_USAGE_URL, &report).await {
            log::info!("{e}; again in an hour");
            return;
        }
        // A "no" while it went: the book was emptied, and stays empty.
        usage.change(|b| {
            if b.answer == Answer::Yes && b.copy.as_deref() == report.get("copy").and_then(Value::as_str) {
                b.mark_sent(&day, report, &today);
            }
        });
    }
}

/// The answer and the last report, for the question and for Settings.
#[tauri::command]
pub fn usage_get(usage: State<'_, UsageState>) -> UsageView {
    usage.view()
}

/// The person's answer. A yes counts this opening at once (the question came after the app
/// opened); a no forgets the number and every count (hproxy-api, `Book::set_answer`).
#[tauri::command]
pub fn usage_answer(app: AppHandle, usage: State<'_, UsageState>, yes: bool) -> UsageView {
    let was_yes = usage.answer() == Answer::Yes;
    usage.change(|b| b.set_answer(yes));
    if yes && !was_yes {
        opened(&app);
    }
    usage.view()
}

/// Something only the window sees: a search, a crash of the window. A word off the fixed lists
/// is never counted (hproxy-api, `usage`).
#[tauri::command]
pub fn usage_count(app: AppHandle, event: Event) {
    match &event {
        Event::Feature { .. } | Event::Crash { .. } => count(&app, event),
        // The rest is counted where it happens, on this side.
        _ => {}
    }
}
