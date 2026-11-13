//! How a finished deployment is announced. Pure. Mirrors
//! `desktop/src/main/deploy-outcome.ts`.
//!
//! The statuses are the dashboard's own (`lib/deploy/status.ts`): a deployment
//! that ends `running` or `success` is serving; every other final state is a
//! failure worth a notice. The words match the dashboard's alert for the same
//! event (`lib/notifications/deploy-events.ts`), so both read the same.

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Outcome {
    pub ok: bool,
    pub title: String,
    pub body: String,
}

/// The first line of a failure, short enough for a notice.
pub fn first_line(error: Option<&str>) -> String {
    let line = error
        .unwrap_or("")
        .split('\n')
        .map(str::trim)
        .find(|part| !part.is_empty());
    let Some(line) = line else {
        return "No reason was reported. Open the deploy log for the detail.".to_owned();
    };
    // Counted in UTF-16 units, as JavaScript's `length` and `slice` count.
    let units: Vec<u16> = line.encode_utf16().collect();
    if units.len() > 300 {
        format!("{}...", String::from_utf16_lossy(&units[..297]))
    } else {
        line.to_owned()
    }
}

pub fn deploy_outcome(service: &str, status: &str, error: Option<&str>) -> Outcome {
    if matches!(status, "running" | "success") {
        Outcome {
            ok: true,
            title: format!("Deployed {service}"),
            body: format!("{service} is serving the new release."),
        }
    } else {
        Outcome {
            ok: false,
            title: format!("Deploy failed: {service}"),
            body: first_line(error),
        }
    }
}
