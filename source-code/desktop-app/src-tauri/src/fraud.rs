//! Fraud scores for the window: the addresses it asks about, looked up with
//! the service the person picked (`hproxy_api::fraud`: FFraud's free lookup by
//! default, or their own key elsewhere). From this computer straight to that
//! service; nothing goes through HProxy.
//!
//! A few at a time, so a column of a few hundred exits neither floods a
//! service nor waits one by one. Every address comes back, with its score or
//! with the sentence that says why there is none.

use std::collections::HashSet;
use std::time::Duration;

use futures::StreamExt;
use hproxy_api::fraud::{lookup, FraudScore, FraudService};
use serde::Serialize;

/// Lookups in flight at once.
const AT_ONCE: usize = 6;

#[derive(Serialize)]
pub struct FraudRow {
    ip: String,
    score: Option<FraudScore>,
    error: Option<String>,
}

#[tauri::command]
pub async fn fraud_lookup(ips: Vec<String>, service: FraudService) -> Vec<FraudRow> {
    let http = hproxy_api::http_client("hproxy-checker", Duration::from_secs(12));
    let mut seen = HashSet::new();
    let ips: Vec<String> = ips
        .into_iter()
        .map(|ip| ip.trim().to_string())
        .filter(|ip| !ip.is_empty() && seen.insert(ip.clone()))
        .collect();
    let (http, service) = (&http, &service);
    futures::stream::iter(ips)
        .map(|ip| async move {
            match lookup(http, service, &ip).await {
                Ok(score) => FraudRow {
                    ip,
                    score: Some(score),
                    error: None,
                },
                Err(error) => FraudRow {
                    ip,
                    score: None,
                    error: Some(error),
                },
            }
        })
        .buffer_unordered(AT_ONCE)
        .collect()
        .await
}
