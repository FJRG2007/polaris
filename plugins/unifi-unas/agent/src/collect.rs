//! System, drive, storage and network collectors.
//!
//! Ported from the upstream `unas_monitor.py`. Reads procfs/sysfs directly and
//! shells out to `smartctl`, `df`, `smbstatus`, `showmount` and `udevadm`,
//! exactly as upstream did, then hands typed models to the core crate.

use std::collections::{HashMap, HashSet};
use std::thread::sleep;
use std::time::{Duration, Instant};

use serde_json::Value;

use polaris_unas_core::bays::DeviceModel;
use polaris_unas_core::model::{
    HddDrive, NfsMount, NvmeDrive, Pool, Share, ShareMember, SmbClient, SystemMetrics,
};
use polaris_unas_core::smart;

use crate::api::ApiClient;
use crate::util::{log, read_first_token, read_trim, run};

const GRACE_PERIOD: Duration = Duration::from_secs(60);
const CMD_TIMEOUT: u32 = 10;

pub struct Monitor {
    model: DeviceModel,
    machine_id: String,
    api: ApiClient,
    prev_cpu: Option<(u64, u64)>,
    prev_disk: Option<(u64, u64, Instant)>,
    bay_cache: HashMap<String, Option<String>>,
    known_drives: HashSet<String>,
    prev_drive_map: HashMap<String, String>,
    removed_at: HashMap<String, (Instant, String)>,
}

impl Monitor {
    pub fn new(model: DeviceModel) -> Self {
        Self {
            model,
            machine_id: read_trim("/etc/machine-id").unwrap_or_default(),
            api: ApiClient::new(),
            prev_cpu: None,
            prev_disk: None,
            bay_cache: HashMap::new(),
            known_drives: HashSet::new(),
            prev_drive_map: HashMap::new(),
            removed_at: HashMap::new(),
        }
    }

    pub fn is_unvr(&self) -> bool {
        self.model.is_unvr()
    }

    // --- System -------------------------------------------------------------

    pub fn system_metrics(&mut self) -> SystemMetrics {
        let uptime = read_first_token("/proc/uptime")
            .and_then(|s| s.parse::<f64>().ok())
            .map(|f| f as u64)
            .unwrap_or(0);

        let os_version = read_trim("/usr/lib/version")
            .map(|s| parse_os_version(&s))
            .unwrap_or_default();

        let (drive_version, protect_version) = if self.model.is_unvr() {
            (None, Some(pkg_version("unifi-protect")))
        } else {
            (Some(pkg_version("unifi-drive")), None)
        };

        let cpu_usage = self.cpu_usage();
        let (disk_read, disk_write) = self.disk_throughput();
        let (memory_total, memory_used, memory_usage) = memory();
        let cpu_temp = read_trim("/sys/class/thermal/thermal_zone0/temp")
            .and_then(|s| s.parse::<i64>().ok())
            .map(|v| v / 1000)
            .unwrap_or(0);
        let (fan_speed, fan_speed_percent) = fan_pwm();

        SystemMetrics {
            machine_id: self.machine_id.clone(),
            uptime,
            os_version,
            drive_version,
            protect_version,
            cpu_usage,
            cpu_temp,
            disk_read,
            disk_write,
            memory_total,
            memory_used,
            memory_usage,
            fan_speed,
            fan_speed_percent,
        }
    }

    fn cpu_usage(&mut self) -> i64 {
        match self.prev_cpu {
            None => {
                let Some(start) = read_proc_stat() else {
                    return 0;
                };
                sleep(Duration::from_secs(1));
                let Some(end) = read_proc_stat() else {
                    return 0;
                };
                self.prev_cpu = Some(end);
                cpu_percent(start, end)
            }
            Some(prev) => {
                let Some(now) = read_proc_stat() else {
                    return 0;
                };
                self.prev_cpu = Some(now);
                cpu_percent(prev, now)
            }
        }
    }

    fn disk_throughput(&mut self) -> (f64, f64) {
        match self.prev_disk {
            None => {
                let (r0, w0) = read_diskstats();
                let t0 = Instant::now();
                sleep(Duration::from_secs(1));
                let (r1, w1) = read_diskstats();
                let t1 = Instant::now();
                self.prev_disk = Some((r1, w1, t1));
                throughput(r0, w0, r1, w1, (t1 - t0).as_secs_f64())
            }
            Some((pr, pw, pt)) => {
                let (r, w) = read_diskstats();
                let now = Instant::now();
                self.prev_disk = Some((r, w, now));
                throughput(pr, pw, r, w, (now - pt).as_secs_f64())
            }
        }
    }

    // --- Drives -------------------------------------------------------------

    /// Returns the discovered drives and their positive temperatures.
    pub fn drives(&mut self) -> (Vec<HddDrive>, Vec<i64>) {
        let current: HashSet<String> = block_devices(|n| n.len() == 3 && n.starts_with("sd"));
        if current != self.known_drives {
            self.bay_cache.clear();
            self.known_drives = current.clone();
        }

        let mut names: Vec<String> = current.into_iter().collect();
        names.sort();

        let mut drives = Vec::new();
        let mut current_map: HashMap<String, String> = HashMap::new();
        for device in &names {
            let Some(bay) = self.bay_number(device) else {
                continue;
            };
            let out = run(
                "smartctl",
                &["-a", "-j", &format!("/dev/{device}")],
                CMD_TIMEOUT,
            );
            if out.is_empty() {
                continue;
            }
            match smart::parse_hdd(&out, bay) {
                Ok(Some(d)) => {
                    current_map.insert(d.serial.clone(), d.bay.clone());
                    drives.push(d);
                }
                Ok(None) => {}
                Err(e) => log(format!(
                    "WARNING: smartctl JSON parse failed for {device}: {e}"
                )),
            }
        }

        self.track_drive_changes(&current_map);
        self.prev_drive_map = current_map;

        let temps: Vec<i64> = drives
            .iter()
            .map(|d| d.temperature)
            .filter(|t| *t > 0)
            .collect();
        (drives, temps)
    }

    fn bay_number(&mut self, device: &str) -> Option<String> {
        if let Some(cached) = self.bay_cache.get(device) {
            return cached.clone();
        }
        let out = run(
            "udevadm",
            &["info", "-q", "path", "-n", &format!("/dev/{device}")],
            CMD_TIMEOUT,
        );
        let mut bay = None;
        for part in out.split('/') {
            if let Some(ata) = part.strip_prefix("ata") {
                if let Some(mapped) = self.model.ata_to_bay(ata) {
                    bay = Some(mapped.to_string());
                    break;
                }
            }
        }
        self.bay_cache.insert(device.to_string(), bay.clone());
        bay
    }

    /// Log drive moves and manage the removal grace period (parity with upstream).
    fn track_drive_changes(&mut self, current: &HashMap<String, String>) {
        let now = Instant::now();
        for (serial, old_bay) in &self.prev_drive_map {
            if let Some(new_bay) = current.get(serial) {
                if old_bay != new_bay {
                    log(format!(
                        "Drive {serial} moved from bay {old_bay} to bay {new_bay}"
                    ));
                }
            }
        }
        for (serial, old_bay) in &self.prev_drive_map {
            if !current.contains_key(serial) && !self.removed_at.contains_key(serial) {
                log(format!(
                    "Drive {serial} removed from bay {old_bay}, starting grace period"
                ));
                self.removed_at
                    .insert(serial.clone(), (now, old_bay.clone()));
            }
        }
        let expired: Vec<String> = self
            .removed_at
            .iter()
            .filter(|(serial, (t, _))| {
                current.contains_key(*serial) || now.duration_since(*t) > GRACE_PERIOD
            })
            .map(|(serial, _)| serial.clone())
            .collect();
        for serial in expired {
            self.removed_at.remove(&serial);
        }
    }

    pub fn nvme_drives(&self) -> Vec<NvmeDrive> {
        let mut names: Vec<String> = block_devices(|n| n.starts_with("nvme") && n.ends_with("n1"))
            .into_iter()
            .collect();
        names.sort();

        let mut out = Vec::new();
        for device in &names {
            let slot = device.replace("nvme", "").replace("n1", "");
            let raw = run(
                "smartctl",
                &["-a", "-j", &format!("/dev/{device}")],
                CMD_TIMEOUT,
            );
            if raw.is_empty() {
                continue;
            }
            match smart::parse_nvme(&raw, slot) {
                Ok(Some(d)) => out.push(d),
                Ok(None) => {}
                Err(e) => log(format!(
                    "WARNING: smartctl JSON parse failed for {device}: {e}"
                )),
            }
        }
        out
    }

    // --- Storage ------------------------------------------------------------

    pub fn pools(&mut self) -> Vec<Pool> {
        if let Some(data) = self.api.get("/api/v2/storage", false) {
            if let Some(pools) = data.get("pools").and_then(Value::as_array) {
                return pools.iter().map(pool_from_api).collect();
            }
        }
        pools_from_df()
    }

    pub fn shares(&mut self) -> Vec<Share> {
        let storage = self.api.get("/api/v2/storage", false);
        let mut pool_id_to_num: HashMap<String, i64> = HashMap::new();
        if let Some(pools) = storage
            .as_ref()
            .and_then(|s| s.get("pools"))
            .and_then(Value::as_array)
        {
            for p in pools {
                if let Some(id) = p.get("id").and_then(Value::as_str) {
                    pool_id_to_num.insert(
                        id.to_string(),
                        p.get("number").and_then(Value::as_i64).unwrap_or(1),
                    );
                }
            }
        }

        let Some(drives_data) = self.api.get("/api/v2/drives", true) else {
            return Vec::new();
        };
        let Some(drives) = drives_data.get("drives").and_then(Value::as_array) else {
            return Vec::new();
        };

        let (user_map, console_owner) = self.user_map();

        let mut shares = Vec::new();
        for drive in drives {
            if drive.get("type").and_then(Value::as_str) != Some("shared") {
                continue;
            }
            let usage = drive.get("usage").and_then(Value::as_f64).unwrap_or(0.0);
            let quota = drive.get("quota").and_then(Value::as_i64).unwrap_or(-1);
            let protections = drive.get("protections").cloned().unwrap_or(Value::Null);
            let pool_id = drive
                .get("storagePoolId")
                .and_then(Value::as_str)
                .unwrap_or("");
            let pool_num = pool_id_to_num
                .get(pool_id)
                .map(|n| n.to_string())
                .unwrap_or_else(|| "?".into());
            let member_count = drive
                .get("memberCount")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            let drive_id = drive.get("id").and_then(Value::as_str).unwrap_or("");
            let members =
                self.share_members(drive_id, member_count, &user_map, console_owner.as_ref());

            shares.push(Share {
                name: drive
                    .get("name")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
                usage: (usage / 1_000_000_000.0 * 100.0).round() / 100.0,
                quota,
                pool: pool_num,
                member_count,
                members,
                snapshot_enabled: protections
                    .get("snapshotEnabled")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                encryption: protections
                    .get("encryptionStatus")
                    .and_then(Value::as_str)
                    .unwrap_or("unknown")
                    .to_string(),
            });
        }
        shares
    }

    fn user_map(&mut self) -> (HashMap<String, String>, Option<ConsoleOwner>) {
        let Some(data) = self.api.get("/api/v1/users", false) else {
            return (HashMap::new(), None);
        };
        let Some(users) = data.get("data").and_then(Value::as_array) else {
            return (HashMap::new(), None);
        };
        let mut map = HashMap::new();
        let mut owner = None;
        for u in users {
            let Some(id) = u.get("id").and_then(Value::as_str) else {
                continue;
            };
            let name = u
                .get("fullName")
                .and_then(Value::as_str)
                .or_else(|| u.get("firstName").and_then(Value::as_str))
                .unwrap_or("Unknown")
                .to_string();
            if owner.is_none() {
                owner = Some(ConsoleOwner {
                    id: id.to_string(),
                    name: name.clone(),
                });
            }
            map.insert(id.to_string(), name);
        }
        (map, owner)
    }

    fn share_members(
        &mut self,
        drive_id: &str,
        member_count: i64,
        user_map: &HashMap<String, String>,
        console_owner: Option<&ConsoleOwner>,
    ) -> Vec<ShareMember> {
        let Some(detail) = self.api.get(&format!("/api/v2/drives/{drive_id}"), true) else {
            return Vec::new();
        };
        let Some(raw_members) = detail.get("members").and_then(Value::as_array) else {
            return Vec::new();
        };

        let mut members: Vec<ShareMember> = raw_members
            .iter()
            .map(|m| {
                let id = m.get("id").and_then(Value::as_str).unwrap_or("");
                ShareMember {
                    name: user_map
                        .get(id)
                        .cloned()
                        .unwrap_or_else(|| "Unknown".into()),
                    role: m
                        .get("role")
                        .and_then(Value::as_str)
                        .unwrap_or("unknown")
                        .to_string(),
                }
            })
            .collect();

        // The console owner has implicit access to every share but is not listed.
        if let Some(owner) = console_owner {
            if member_count > members.len() as i64 {
                let listed: HashSet<&str> = raw_members
                    .iter()
                    .filter_map(|m| m.get("id").and_then(Value::as_str))
                    .collect();
                if !listed.contains(owner.id.as_str()) {
                    members.insert(
                        0,
                        ShareMember {
                            name: owner.name.clone(),
                            role: "admin".into(),
                        },
                    );
                }
            }
        }
        members
    }

    // --- Network ------------------------------------------------------------

    pub fn smb(&self) -> (usize, Vec<SmbClient>) {
        let connections = smb_connections();
        let shares = smb_shares();
        let clients: Vec<SmbClient> = shares
            .iter()
            .map(|(share, pid, ip)| {
                let username = connections
                    .get(pid)
                    .cloned()
                    .unwrap_or_else(|| "unknown".into());
                SmbClient {
                    username,
                    ip: ip.clone(),
                    share: share.clone(),
                }
            })
            .collect();
        (shares.len(), clients)
    }

    pub fn nfs(&self) -> (usize, Vec<NfsMount>) {
        let out = run("showmount", &["-a"], CMD_TIMEOUT);
        let mounts: Vec<NfsMount> = out
            .lines()
            .skip(1)
            .filter_map(|line| {
                let line = line.trim();
                if line.is_empty() {
                    return None;
                }
                let (ip, path) = line.split_once(':')?;
                let share = path
                    .split_once("/.srv/.unifi-drive/")
                    .map(|(_, rest)| rest.split('/').next().unwrap_or("unknown").to_string())
                    .unwrap_or_else(|| "unknown".into());
                Some(NfsMount {
                    ip: ip.to_string(),
                    share,
                })
            })
            .collect();
        (mounts.len(), mounts)
    }
}

struct ConsoleOwner {
    id: String,
    name: String,
}

// --- Free helpers -----------------------------------------------------------

fn parse_os_version(s: &str) -> String {
    if let Some(pos) = s.find(".v") {
        let rest = &s[pos + 2..];
        let ver: String = rest
            .chars()
            .take_while(|c| c.is_ascii_digit() || *c == '.')
            .collect();
        let groups: Vec<&str> = ver.trim_end_matches('.').split('.').collect();
        if groups.len() >= 3
            && groups[..3]
                .iter()
                .all(|g| !g.is_empty() && g.bytes().all(|b| b.is_ascii_digit()))
        {
            return format!("{}.{}.{}", groups[0], groups[1], groups[2]);
        }
    }
    s.trim().to_string()
}

fn pkg_version(pkg: &str) -> String {
    run("dpkg-query", &["-W", "-f=${Version}", pkg], CMD_TIMEOUT)
        .trim()
        .to_string()
}

fn read_proc_stat() -> Option<(u64, u64)> {
    let content = read_trim("/proc/stat")?;
    let line = content.lines().next()?;
    let values: Vec<u64> = line
        .split_whitespace()
        .skip(1)
        .filter_map(|v| v.parse().ok())
        .collect();
    if values.len() < 5 {
        return None;
    }
    let idle = values[3] + values[4]; // idle + iowait
    let total: u64 = values.iter().sum();
    Some((idle, total))
}

fn cpu_percent(start: (u64, u64), end: (u64, u64)) -> i64 {
    let delta_idle = end.0.saturating_sub(start.0) as f64;
    let delta_total = end.1.saturating_sub(start.1) as f64;
    if delta_total <= 0.0 {
        return 0;
    }
    (100.0 * (1.0 - delta_idle / delta_total)) as i64
}

fn read_diskstats() -> (u64, u64) {
    let Some(content) = read_trim("/proc/diskstats") else {
        return (0, 0);
    };
    let mut read = 0u64;
    let mut write = 0u64;
    for line in content.lines() {
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 10 {
            continue;
        }
        let device = parts[2];
        if device.len() == 3 && device.starts_with("sd") {
            read += parts[5].parse::<u64>().unwrap_or(0);
            write += parts[9].parse::<u64>().unwrap_or(0);
        }
    }
    (read, write)
}

fn throughput(r0: u64, w0: u64, r1: u64, w1: u64, dt: f64) -> (f64, f64) {
    if dt <= 0.0 {
        return (0.0, 0.0);
    }
    let mb = |sectors: u64| (sectors as f64 * 512.0 / dt) / (1024.0 * 1024.0);
    let round2 = |v: f64| (v * 100.0).round() / 100.0;
    (
        round2(mb(r1.saturating_sub(r0))),
        round2(mb(w1.saturating_sub(w0))),
    )
}

fn memory() -> (u64, u64, f64) {
    let Some(content) = read_trim("/proc/meminfo") else {
        return (0, 0, 0.0);
    };
    let mut total_kb = 0u64;
    let mut avail_kb = 0u64;
    for line in content.lines() {
        let mut parts = line.split_whitespace();
        match parts.next().map(|k| k.trim_end_matches(':')) {
            Some("MemTotal") => total_kb = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0),
            Some("MemAvailable") => {
                avail_kb = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0)
            }
            _ => {}
        }
    }
    let total = total_kb / 1024;
    let avail = avail_kb / 1024;
    let used = total.saturating_sub(avail);
    let usage = if total > 0 {
        (used as f64 / total as f64 * 1000.0).round() / 10.0
    } else {
        0.0
    };
    (total, used, usage)
}

fn fan_pwm() -> (i64, i64) {
    match read_trim("/sys/class/hwmon/hwmon0/pwm1").and_then(|s| s.parse::<i64>().ok()) {
        Some(pwm) => (pwm, pwm * 100 / 255),
        None => (0, 0),
    }
}

/// Names in `/dev` matching a predicate.
fn block_devices(pred: impl Fn(&str) -> bool) -> HashSet<String> {
    let Ok(entries) = std::fs::read_dir("/dev") else {
        return HashSet::new();
    };
    entries
        .filter_map(|e| e.ok())
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| pred(n))
        .collect()
}

fn pool_from_api(pool: &Value) -> Pool {
    let capacity = pool.get("capacity").and_then(Value::as_f64).unwrap_or(0.0);
    let usage = pool.get("usage").and_then(Value::as_f64).unwrap_or(0.0);
    let capacity_gb = (capacity / 1_000_000_000.0).round() as i64;
    let usage_gb = (usage / 1_000_000_000.0).round() as i64;
    let usage_pct = if capacity > 0.0 {
        (usage / capacity * 100.0).round() as i64
    } else {
        0
    };

    let raid = pool
        .get("raidGroups")
        .and_then(Value::as_array)
        .and_then(|g| g.first());
    let raid_level = raid
        .and_then(|r| r.get("currentLevel"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let protection = raid
        .and_then(|r| r.get("currentProtection"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    Pool {
        number: pool.get("number").and_then(Value::as_i64).unwrap_or(1) as u32,
        size: capacity_gb,
        used: usage_gb,
        available: capacity_gb - usage_gb,
        usage: usage_pct,
        status: Some(
            pool.get("status")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string(),
        ),
        raid_level: Some(raid_level),
        protection: Some(protection),
    }
}

fn pools_from_df() -> Vec<Pool> {
    let Ok(entries) = std::fs::read_dir("/volume") else {
        return Vec::new();
    };
    let mut dirs: Vec<String> = entries
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_dir())
        .filter_map(|e| e.path().to_str().map(str::to_owned))
        .collect();
    dirs.sort();

    let mut pools = Vec::new();
    let mut number = 1u32;
    for dir in dirs {
        let out = run("df", &["-B1", &dir], CMD_TIMEOUT);
        let Some(line) = out.lines().nth(1) else {
            continue;
        };
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 5 {
            continue;
        }
        let round_gb = |s: &str| (s.parse::<f64>().unwrap_or(0.0) / 1_000_000_000.0).round() as i64;
        let size = round_gb(parts[1]);
        if size <= 75 {
            continue; // skip small system volumes
        }
        pools.push(Pool {
            number,
            size,
            used: round_gb(parts[2]),
            available: round_gb(parts[3]),
            usage: parts[4].trim_end_matches('%').parse().unwrap_or(0),
            status: None,
            raid_level: None,
            protection: None,
        });
        number += 1;
    }
    pools
}

/// PID -> username from `smbstatus -b`.
fn smb_connections() -> HashMap<String, String> {
    let out = run("smbstatus", &["-b"], CMD_TIMEOUT);
    let mut map = HashMap::new();
    for line in out.lines().skip(3) {
        let line = line.trim();
        if line.is_empty() || line.starts_with("---") {
            continue;
        }
        let parts: Vec<&str> = line.split_whitespace().collect();
        if parts.len() < 6 {
            continue;
        }
        map.insert(parts[0].to_string(), parts[1].to_string());
    }
    map
}

/// (share, pid, ip) tuples from `smbstatus -S`.
fn smb_shares() -> Vec<(String, String, String)> {
    let out = run("smbstatus", &["-S"], CMD_TIMEOUT);
    out.lines()
        .skip(2)
        .filter_map(|line| {
            let line = line.trim();
            if line.is_empty() || line.starts_with("---") {
                return None;
            }
            let parts: Vec<&str> = line.split_whitespace().collect();
            if parts.len() < 3 {
                return None;
            }
            Some((
                parts[0].to_string(),
                parts[1].to_string(),
                parts[2].to_string(),
            ))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn os_version_extracts_semver() {
        assert_eq!(parse_os_version("unifi-drive.v6.0.16.abcdef"), "6.0.16");
        assert_eq!(parse_os_version("no-version-here"), "no-version-here");
    }

    #[test]
    fn cpu_percent_math() {
        // 10 of 100 ticks idle -> 90% busy.
        assert_eq!(cpu_percent((0, 0), (10, 100)), 90);
        assert_eq!(cpu_percent((5, 10), (5, 10)), 0); // no elapsed time
    }

    #[test]
    fn throughput_zero_dt_is_safe() {
        assert_eq!(throughput(0, 0, 100, 100, 0.0), (0.0, 0.0));
    }
}
