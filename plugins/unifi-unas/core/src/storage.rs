//! Storage, network and file-service values the console shows, derived from
//! data the agent reads on the device.
//!
//! Every parser here takes the text of a documented Linux or Samba interface
//! (md sysfs, `testparm -s`, `ip -o addr`, `/proc/net/dev`) and never touches
//! the system itself, so the agent and the Polaris dashboard share the exact
//! same interpretation. Where each value comes from is recorded in
//! `plugins/unifi-unas/docs/data-sources.md`.

use serde::Serialize;

use crate::model::{HddDrive, ToMqttFields};

/// The "All Disks" row of the console's Storage screen: how many bays hold a
/// drive and the temperature and power-on-hours spread across them.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiskSummary {
    pub disk_count: usize,
    pub bay_count: usize,
    pub disk_temp_max: Option<i64>,
    pub disk_temp_min: Option<i64>,
    pub disk_power_on_hours_avg: Option<i64>,
    /// Drives whose SMART status is anything other than `Optimal`.
    pub disks_not_optimal: usize,
}

impl DiskSummary {
    pub fn from_drives(drives: &[HddDrive], bay_count: usize) -> Self {
        let temps: Vec<i64> = drives
            .iter()
            .map(|d| d.temperature)
            .filter(|t| *t > 0)
            .collect();
        let hours: Vec<i64> = drives.iter().map(|d| d.power_on_hours).collect();
        let avg = if hours.is_empty() {
            None
        } else {
            Some((hours.iter().sum::<i64>() as f64 / hours.len() as f64).round() as i64)
        };
        Self {
            disk_count: drives.len(),
            bay_count,
            disk_temp_max: temps.iter().copied().max(),
            disk_temp_min: temps.iter().copied().min(),
            disk_power_on_hours_avg: avg,
            disks_not_optimal: drives.iter().filter(|d| d.status != "Optimal").count(),
        }
    }
}

impl ToMqttFields for DiskSummary {
    fn to_mqtt_fields(&self) -> Vec<(&'static str, String)> {
        let mut f = vec![
            ("disk_count", self.disk_count.to_string()),
            ("disk_bays", self.bay_count.to_string()),
            ("disks_not_optimal", self.disks_not_optimal.to_string()),
        ];
        if let Some(v) = self.disk_temp_max {
            f.push(("disk_temp_max", v.to_string()));
        }
        if let Some(v) = self.disk_temp_min {
            f.push(("disk_temp_min", v.to_string()));
        }
        if let Some(v) = self.disk_power_on_hours_avg {
            f.push(("disk_power_on_hours_avg", v.to_string()));
        }
        f
    }
}

/// The state of one md array's consistency check, read from
/// `/sys/block/<md>/md/{sync_action,mismatch_cnt,sync_completed}` (Linux
/// `Documentation/admin-guide/md.rst`).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct ScrubState {
    /// Array name, e.g. `md3`; the MQTT subtree key, not published as a field.
    pub array: String,
    /// `idle`, `check`, `repair`, `resync`, `recover`, `reshape` or `frozen`.
    pub action: String,
    /// Sectors found inconsistent by the last check or repair.
    pub mismatches: u64,
    /// Progress of the running action, 0-100, when one is running.
    pub progress: Option<f64>,
}

impl ScrubState {
    /// `sync_completed` is `"<done> / <total>"` in sectors, or `none`.
    pub fn parse(array: &str, sync_action: &str, mismatch_cnt: &str, sync_completed: &str) -> Self {
        let progress = sync_completed.split_once('/').and_then(|(done, total)| {
            let done: f64 = done.trim().parse().ok()?;
            let total: f64 = total.trim().parse().ok()?;
            (total > 0.0).then(|| (done / total * 1000.0).round() / 10.0)
        });
        Self {
            array: array.to_string(),
            action: sync_action.trim().to_string(),
            mismatches: mismatch_cnt.trim().parse().unwrap_or(0),
            progress,
        }
    }

    /// True while the array is doing anything other than sitting idle.
    pub fn running(&self) -> bool {
        !matches!(self.action.as_str(), "idle" | "frozen" | "")
    }
}

impl ToMqttFields for ScrubState {
    fn to_mqtt_fields(&self) -> Vec<(&'static str, String)> {
        let mut f = vec![
            ("action", self.action.clone()),
            ("mismatches", self.mismatches.to_string()),
            (
                "running",
                if self.running() { "ON" } else { "OFF" }.to_string(),
            ),
        ];
        f.push((
            "progress",
            self.progress
                .map(|p| format!("{p}"))
                .unwrap_or_else(|| "0".into()),
        ));
        f
    }
}

/// Share names that Samba advertises as Time Machine targets, from the
/// `testparm -s` dump (`fruit:time machine = yes`, Samba `vfs_fruit(8)`).
pub fn time_machine_shares(testparm: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut section: Option<String> = None;
    for line in testparm.lines() {
        let line = line.trim();
        if let Some(name) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) {
            section = Some(name.to_string());
            continue;
        }
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim().to_ascii_lowercase();
        let on = matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "yes" | "true" | "1"
        );
        if key == "fruit:time machine" && on {
            if let Some(name) = &section {
                if name != "global" && !out.contains(name) {
                    out.push(name.clone());
                }
            }
        }
    }
    out
}

/// The console's native fan profiles (Quiet / Balanced / Cooling).
///
/// The wire values are the ones the community integration documents for the
/// Drive `systems/fan-control` endpoint; Balanced is sent as `default`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FanProfile {
    Quiet,
    Balanced,
    Cooling,
}

impl FanProfile {
    pub const ALL: [FanProfile; 3] = [Self::Quiet, Self::Balanced, Self::Cooling];

    /// The option name Home Assistant and Polaris show and publish.
    pub fn key(self) -> &'static str {
        match self {
            Self::Quiet => "quiet",
            Self::Balanced => "balanced",
            Self::Cooling => "cooling",
        }
    }

    /// The value written to the Drive API.
    pub fn api_value(self) -> &'static str {
        match self {
            Self::Quiet => "quiet",
            Self::Balanced => "default",
            Self::Cooling => "cooling",
        }
    }

    /// Accept either the option name or any value the API is known to report.
    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "quiet" => Some(Self::Quiet),
            "balanced" | "balance" | "default" | "default_profile" => Some(Self::Balanced),
            "cooling" | "cool" => Some(Self::Cooling),
            _ => None,
        }
    }
}

/// The IPv4 address in `ip -4 -o addr show dev <iface>` output.
pub fn parse_ipv4(ip_output: &str) -> Option<String> {
    for line in ip_output.lines() {
        let mut parts = line.split_whitespace();
        while let Some(token) = parts.next() {
            if token == "inet" {
                let cidr = parts.next()?;
                return Some(cidr.split('/').next().unwrap_or(cidr).to_string());
            }
        }
    }
    None
}

/// `(rx_bytes, tx_bytes)` for one interface from `/proc/net/dev`.
pub fn parse_net_dev(content: &str, iface: &str) -> Option<(u64, u64)> {
    for line in content.lines() {
        let Some((name, rest)) = line.split_once(':') else {
            continue;
        };
        if name.trim() != iface {
            continue;
        }
        let fields: Vec<u64> = rest
            .split_whitespace()
            .filter_map(|v| v.parse().ok())
            .collect();
        if fields.len() < 9 {
            return None;
        }
        return Some((fields[0], fields[8]));
    }
    None
}

/// The interface carrying the default route, from `/proc/net/route`
/// (destination `00000000`).
pub fn default_route_iface(route: &str) -> Option<String> {
    route.lines().skip(1).find_map(|line| {
        let mut parts = line.split_whitespace();
        let iface = parts.next()?;
        (parts.next()? == "00000000").then(|| iface.to_string())
    })
}

/// The uplink the console reports under Network.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct NetworkLink {
    pub interface: String,
    pub ip: Option<String>,
    /// Negotiated link speed in Mbit/s, from `/sys/class/net/<iface>/speed`.
    pub speed: Option<i64>,
    /// `up` / `down`, from `/sys/class/net/<iface>/operstate`.
    pub state: String,
    pub rx_rate: f64,
    pub tx_rate: f64,
}

impl ToMqttFields for NetworkLink {
    fn to_mqtt_fields(&self) -> Vec<(&'static str, String)> {
        let mut f = vec![
            ("interface", self.interface.clone()),
            ("state", self.state.clone()),
            ("rx_rate", format!("{}", self.rx_rate)),
            ("tx_rate", format!("{}", self.tx_rate)),
        ];
        if let Some(ip) = &self.ip {
            f.push(("ip", ip.clone()));
        }
        if let Some(s) = self.speed {
            f.push(("speed", s.to_string()));
        }
        f
    }
}

/// Bytes moved over `dt` seconds as MB/s (MiB, matching the disk rates).
pub fn rate_mb(prev: u64, now: u64, dt: f64) -> f64 {
    if dt <= 0.0 {
        return 0.0;
    }
    let mb = now.saturating_sub(prev) as f64 / dt / (1024.0 * 1024.0);
    (mb * 100.0).round() / 100.0
}

#[cfg(test)]
mod tests {
    use super::*;

    fn drive(bay: &str, status: &str, temp: i64, hours: i64) -> HddDrive {
        HddDrive {
            bay: bay.into(),
            model: "m".into(),
            serial: format!("s{bay}"),
            firmware: "f".into(),
            status: status.into(),
            temperature: temp,
            rpm: None,
            power_on_hours: hours,
            bad_sectors: 0,
            total_size: 8.0,
        }
    }

    #[test]
    fn summary_matches_the_all_disks_row() {
        let s = DiskSummary::from_drives(
            &[
                drive("1", "Optimal", 34, 100),
                drive("2", "Warning", 41, 201),
                drive("3", "Optimal", 0, 0),
            ],
            7,
        );
        assert_eq!(s.disk_count, 3);
        assert_eq!(s.bay_count, 7);
        assert_eq!(s.disk_temp_max, Some(41));
        assert_eq!(s.disk_temp_min, Some(34));
        assert_eq!(s.disk_power_on_hours_avg, Some(100));
        assert_eq!(s.disks_not_optimal, 1);
    }

    #[test]
    fn summary_of_no_drives_omits_spreads() {
        let s = DiskSummary::from_drives(&[], 4);
        let keys: Vec<_> = s.to_mqtt_fields().into_iter().map(|(k, _)| k).collect();
        assert_eq!(keys, vec!["disk_count", "disk_bays", "disks_not_optimal"]);
    }

    #[test]
    fn scrub_parses_md_sysfs() {
        let s = ScrubState::parse("md3", "check\n", "128\n", "250 / 1000\n");
        assert!(s.running());
        assert_eq!(s.mismatches, 128);
        assert_eq!(s.progress, Some(25.0));
        let idle = ScrubState::parse("md3", "idle", "0", "none");
        assert!(!idle.running());
        assert_eq!(idle.progress, None);
    }

    #[test]
    fn time_machine_reads_vfs_fruit_flag() {
        let dump = "[global]\n\tfruit:time machine = yes\n[Media]\n\tpath = /x\n[Backups]\n\tfruit:time machine = Yes\n[Off]\n\tfruit:time machine = no\n";
        assert_eq!(time_machine_shares(dump), vec!["Backups".to_string()]);
        assert!(time_machine_shares("").is_empty());
    }

    #[test]
    fn fan_profile_round_trips() {
        for p in FanProfile::ALL {
            assert_eq!(FanProfile::parse(p.key()), Some(p));
            assert_eq!(FanProfile::parse(p.api_value()), Some(p));
        }
        assert_eq!(FanProfile::parse("turbo"), None);
    }

    #[test]
    fn network_parsers() {
        let ip = "2: eth0    inet 192.168.1.20/24 brd 192.168.1.255 scope global eth0\\       valid_lft forever";
        assert_eq!(parse_ipv4(ip), Some("192.168.1.20".into()));
        assert_eq!(parse_ipv4(""), None);
        let dev = "Inter-|   Receive\n face |bytes packets errs drop fifo frame compressed multicast|bytes\n  eth0: 1000 1 0 0 0 0 0 0 2000 2 0 0 0 0 0 0\n    lo: 5 0 0 0 0 0 0 0 5 0 0 0 0 0 0 0\n";
        assert_eq!(parse_net_dev(dev, "eth0"), Some((1000, 2000)));
        assert_eq!(parse_net_dev(dev, "eth9"), None);
        assert_eq!(rate_mb(0, 1024 * 1024 * 10, 2.0), 5.0);
        assert_eq!(rate_mb(5, 1, 1.0), 0.0);
        let route = "Iface	Destination	Gateway
br0	0001A8C0	00000000
eth0	00000000	0101A8C0
";
        assert_eq!(default_route_iface(route), Some("eth0".into()));
        assert_eq!(
            default_route_iface(
                "Iface	Destination
"
            ),
            None
        );
    }
}
