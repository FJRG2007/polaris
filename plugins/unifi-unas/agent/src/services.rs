//! Network uplink, data scrubbing, Time Machine and the native fan profile.
//!
//! Each reader uses an interface documented outside UniFi (procfs, sysfs, md,
//! Samba) except the fan profile, which is the Drive endpoint the console's own
//! Fan Mode control calls. Sources are listed in `docs/data-sources.md`.

use std::time::Instant;

use serde_json::{json, Value};

use polaris_unas_core::storage::{
    default_route_iface, parse_ipv4, parse_net_dev, rate_mb, time_machine_shares, FanProfile,
    NetworkLink, ScrubState,
};

use crate::api::ApiClient;
use crate::util::{log, read_trim, run};

const CMD_TIMEOUT: u32 = 10;
/// Path on the local Drive service (`/proxy/drive/api/...` through UniFi OS).
pub const FAN_CONTROL_PATH: &str = "/api/v2/systems/fan-control";

/// Samples the default-route interface and turns byte counters into rates.
#[derive(Default)]
pub struct NetSampler {
    prev: Option<(String, u64, u64, Instant)>,
}

impl NetSampler {
    pub fn sample(&mut self) -> Option<NetworkLink> {
        let iface = default_route_iface(&read_trim("/proc/net/route")?)?;
        let (rx, tx) = parse_net_dev(&read_trim("/proc/net/dev")?, &iface)?;
        let now = Instant::now();
        let (rx_rate, tx_rate) = match &self.prev {
            Some((prev_iface, prx, ptx, pt)) if *prev_iface == iface => {
                let dt = (now - *pt).as_secs_f64();
                (rate_mb(*prx, rx, dt), rate_mb(*ptx, tx, dt))
            }
            _ => (0.0, 0.0),
        };
        self.prev = Some((iface.clone(), rx, tx, now));

        let sys = format!("/sys/class/net/{iface}");
        let speed = read_trim(&format!("{sys}/speed"))
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|s| *s > 0);
        let state = read_trim(&format!("{sys}/operstate")).unwrap_or_else(|| "unknown".into());
        let ip = parse_ipv4(&run(
            "ip",
            &["-4", "-o", "addr", "show", "dev", &iface],
            CMD_TIMEOUT,
        ));
        Some(NetworkLink {
            interface: iface,
            ip,
            speed,
            state,
            rx_rate,
            tx_rate,
        })
    }
}

/// md arrays present on the device (`/sys/block/md*` with an `md/` directory).
fn md_arrays() -> Vec<String> {
    let Ok(entries) = std::fs::read_dir("/sys/block") else {
        return Vec::new();
    };
    let mut names: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with("md"))
        .filter(|n| std::path::Path::new(&format!("/sys/block/{n}/md/sync_action")).exists())
        .collect();
    names.sort();
    names
}

/// The consistency-check state of every md array.
pub fn scrubs() -> Vec<ScrubState> {
    md_arrays()
        .into_iter()
        .map(|md| {
            let base = format!("/sys/block/{md}/md");
            let read = |leaf: &str| read_trim(&format!("{base}/{leaf}")).unwrap_or_default();
            ScrubState::parse(
                &md,
                &read("sync_action"),
                &read("mismatch_cnt"),
                &read("sync_completed"),
            )
        })
        .collect()
}

/// Start a read-only `check` on every idle array. An array already checking,
/// rebuilding or reshaping is left alone; the kernel would refuse it anyway.
pub fn run_scrub() {
    for state in scrubs() {
        if state.running() {
            log(format!(
                "Scrub skipped for {}: {} in progress",
                state.array, state.action
            ));
            continue;
        }
        let path = format!("/sys/block/{}/md/sync_action", state.array);
        match std::fs::write(&path, "check") {
            Ok(()) => log(format!("Scrub started on {}", state.array)),
            Err(e) => log(format!(
                "WARNING: could not start scrub on {}: {e}",
                state.array
            )),
        }
    }
}

/// Shares Samba advertises as Time Machine targets. `None` when `testparm`
/// is missing or prints nothing, so a missing tool never reads as "off".
pub fn time_machine() -> Option<Vec<String>> {
    let dump = run("testparm", &["-s", "--suppress-prompt"], CMD_TIMEOUT);
    if dump.trim().is_empty() {
        return None;
    }
    Some(time_machine_shares(&dump))
}

/// The profile key (`quiet`/`balanced`/`cooling`) reported by the Drive API.
pub fn fan_profile(api: &mut ApiClient) -> Option<FanProfile> {
    let data = api.get(FAN_CONTROL_PATH, true)?;
    find_profile(&data)
}

fn find_profile(data: &Value) -> Option<FanProfile> {
    for key in ["profile", "fanProfile", "mode"] {
        if let Some(p) = data
            .get(key)
            .and_then(Value::as_str)
            .and_then(FanProfile::parse)
        {
            return Some(p);
        }
    }
    data.get("data").and_then(find_profile)
}

/// Write the native profile. Returns whether the endpoint accepted it.
pub fn set_fan_profile(api: &mut ApiClient, raw: &str) -> bool {
    let Some(profile) = FanProfile::parse(raw) else {
        log(format!("WARNING: unknown fan profile {raw:?}"));
        return false;
    };
    let ok = api
        .send(
            "PUT",
            FAN_CONTROL_PATH,
            &json!({ "profile": profile.api_value() }),
        )
        .is_some();
    log(format!(
        "Fan profile {} {}",
        profile.key(),
        if ok { "applied" } else { "was not accepted" }
    ));
    ok
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn profile_is_found_at_top_level_or_under_data() {
        assert_eq!(
            find_profile(&json!({"profile": "quiet"})),
            Some(FanProfile::Quiet)
        );
        assert_eq!(
            find_profile(&json!({"data": {"profile": "default"}})),
            Some(FanProfile::Balanced)
        );
        assert_eq!(find_profile(&json!({"other": 1})), None);
    }
}
