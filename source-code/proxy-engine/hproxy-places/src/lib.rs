//! The places a person connects through, and what each one is.
//!
//! A place is one of their proxies, one of their groups, or the free pool.
//! They live here, in Rust, for every door (the window, the tray, the phone,
//! the command line and the AI tool), so all of them name a place the same way
//! and none of them holds a password just to show one:
//!
//!   library    the proxies, groups and the picked place, and the view a screen
//!              gets of them (never a password)
//!   store      the one file they are kept in, sealed with the Windows login on
//!              Windows, private to the person's account elsewhere
//!   targeting  what a line's username asks for (country, region, city,
//!              session), so a hundred sessions on one gateway read as a
//!              hundred different places
//!   reminders  which proxies and groups are close to their last day, in
//!              the words every app shows as a notification

pub mod library;
pub mod reminders;
pub mod store;
pub mod targeting;

pub use library::{
    clean_date, day_words, days_left, place_words, proxy_id, Details, Group, GroupInput, GroupSummary, GroupView,
    Library, LibraryView, MemberView, Place, Proxy, ProxyView, Rule, Verdict, WindowStorage, MAX_NOTE,
};
pub use targeting::{read as read_targeting, Targeting};
