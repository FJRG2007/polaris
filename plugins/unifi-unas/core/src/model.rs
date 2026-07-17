//! Device data model and its mapping to retained MQTT fields.
//!
//! Every struct is `Serialize` so the Polaris dashboard can consume the same
//! model natively, while [`ToMqttFields`] renders the exact key/value pairs the
//! Home Assistant entities already expect. Keeping those keys identical to the
//! upstream Python is what lets the HA side stay unchanged.

use serde::Serialize;

/// Renders a domain value into the `(metric, payload)` pairs published under its
/// MQTT subtree (e.g. `hdd/<bay>/temperature`).
pub trait ToMqttFields {
    fn to_mqtt_fields(&self) -> Vec<(&'static str, String)>;
}

/// Format a float the way Home Assistant expects: minimal digits, no trailing
/// zero noise. Values are pre-rounded by the collectors.
fn num(v: f64) -> String {
    if v.fract() == 0.0 {
        format!("{}", v as i64)
    } else {
        format!("{v}")
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SystemMetrics {
    pub machine_id: String,
    pub uptime: u64,
    pub os_version: String,
    /// Drive firmware version (NAS models). Mutually exclusive with `protect_version`.
    pub drive_version: Option<String>,
    /// Protect version (UNVR models). Mutually exclusive with `drive_version`.
    pub protect_version: Option<String>,
    pub cpu_usage: i64,
    pub cpu_temp: i64,
    pub disk_read: f64,
    pub disk_write: f64,
    pub memory_total: u64,
    pub memory_used: u64,
    pub memory_usage: f64,
    pub fan_speed: i64,
    pub fan_speed_percent: i64,
}

impl ToMqttFields for SystemMetrics {
    fn to_mqtt_fields(&self) -> Vec<(&'static str, String)> {
        let mut f = vec![
            ("machine_id", self.machine_id.clone()),
            ("uptime", self.uptime.to_string()),
            ("os_version", self.os_version.clone()),
        ];
        if let Some(v) = &self.drive_version {
            f.push(("drive_version", v.clone()));
        }
        if let Some(v) = &self.protect_version {
            f.push(("protect_version", v.clone()));
        }
        f.extend([
            ("cpu_usage", self.cpu_usage.to_string()),
            ("cpu_temp", self.cpu_temp.to_string()),
            ("disk_read", num(self.disk_read)),
            ("disk_write", num(self.disk_write)),
            ("memory_total", self.memory_total.to_string()),
            ("memory_used", self.memory_used.to_string()),
            ("memory_usage", num(self.memory_usage)),
            ("fan_speed", self.fan_speed.to_string()),
            ("fan_speed_percent", self.fan_speed_percent.to_string()),
        ]);
        f
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct HddDrive {
    /// Physical bay label; the MQTT subtree key, not published as a field.
    pub bay: String,
    pub model: String,
    pub serial: String,
    pub firmware: String,
    pub status: String,
    pub temperature: i64,
    pub rpm: Option<i64>,
    pub power_on_hours: i64,
    pub bad_sectors: i64,
    pub total_size: f64,
}

impl ToMqttFields for HddDrive {
    fn to_mqtt_fields(&self) -> Vec<(&'static str, String)> {
        let mut f = vec![
            ("model", self.model.clone()),
            ("serial", self.serial.clone()),
            ("firmware", self.firmware.clone()),
            ("status", self.status.clone()),
            ("temperature", self.temperature.to_string()),
        ];
        if let Some(rpm) = self.rpm {
            f.push(("rpm", rpm.to_string()));
        }
        f.extend([
            ("power_on_hours", self.power_on_hours.to_string()),
            ("bad_sectors", self.bad_sectors.to_string()),
            ("total_size", num(self.total_size)),
        ]);
        f
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct NvmeDrive {
    /// NVMe slot; the MQTT subtree key, not published as a field.
    pub slot: String,
    pub model: String,
    pub serial: String,
    pub firmware: String,
    pub status: String,
    pub temperature: i64,
    pub power_on_hours: i64,
    pub percentage_used: i64,
    pub available_spare: i64,
    pub media_errors: i64,
    pub unsafe_shutdowns: i64,
    pub total_size: f64,
}

impl ToMqttFields for NvmeDrive {
    fn to_mqtt_fields(&self) -> Vec<(&'static str, String)> {
        vec![
            ("model", self.model.clone()),
            ("serial", self.serial.clone()),
            ("firmware", self.firmware.clone()),
            ("status", self.status.clone()),
            ("temperature", self.temperature.to_string()),
            ("power_on_hours", self.power_on_hours.to_string()),
            ("percentage_used", self.percentage_used.to_string()),
            ("available_spare", self.available_spare.to_string()),
            ("media_errors", self.media_errors.to_string()),
            ("unsafe_shutdowns", self.unsafe_shutdowns.to_string()),
            ("total_size", num(self.total_size)),
        ]
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct Pool {
    /// Pool number; the MQTT subtree key, not published as a field.
    pub number: u32,
    pub size: i64,
    pub used: i64,
    pub available: i64,
    pub usage: i64,
    pub status: Option<String>,
    pub raid_level: Option<String>,
    pub protection: Option<i64>,
}

impl ToMqttFields for Pool {
    fn to_mqtt_fields(&self) -> Vec<(&'static str, String)> {
        let mut f = vec![
            ("size", self.size.to_string()),
            ("used", self.used.to_string()),
            ("available", self.available.to_string()),
            ("usage", self.usage.to_string()),
        ];
        if let Some(v) = &self.status {
            f.push(("status", v.clone()));
        }
        if let Some(v) = &self.raid_level {
            f.push(("raid_level", v.clone()));
        }
        if let Some(v) = self.protection {
            f.push(("protection", v.to_string()));
        }
        f
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct ShareMember {
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Share {
    /// Share name; the MQTT subtree key, not published as a field.
    pub name: String,
    pub usage: f64,
    /// Quota in bytes, or -1 for unlimited (upstream convention).
    pub quota: i64,
    pub pool: String,
    pub member_count: i64,
    pub members: Vec<ShareMember>,
    pub snapshot_enabled: bool,
    pub encryption: String,
}

impl ToMqttFields for Share {
    fn to_mqtt_fields(&self) -> Vec<(&'static str, String)> {
        let members = serde_json::to_string(&self.members).unwrap_or_else(|_| "[]".to_string());
        vec![
            ("usage", num(self.usage)),
            ("quota", self.quota.to_string()),
            ("pool", self.pool.clone()),
            ("member_count", self.member_count.to_string()),
            ("members", members),
            ("snapshot_enabled", self.snapshot_enabled.to_string()),
            ("encryption", self.encryption.clone()),
        ]
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SmbClient {
    pub username: String,
    pub ip: String,
    pub share: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct NfsMount {
    pub ip: String,
    pub share: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hdd_fields_omit_absent_rpm() {
        let d = HddDrive {
            bay: "6".into(),
            model: "WD".into(),
            serial: "S1".into(),
            firmware: "F1".into(),
            status: "Optimal".into(),
            temperature: 38,
            rpm: None,
            power_on_hours: 100,
            bad_sectors: 0,
            total_size: 4.0,
        };
        let keys: Vec<_> = d.to_mqtt_fields().into_iter().map(|(k, _)| k).collect();
        assert!(!keys.contains(&"rpm"));
        assert!(keys.contains(&"temperature"));
    }

    #[test]
    fn share_members_serialize_to_json() {
        let s = Share {
            name: "media".into(),
            usage: 1.5,
            quota: -1,
            pool: "1".into(),
            member_count: 1,
            members: vec![ShareMember {
                name: "alice".into(),
                role: "admin".into(),
            }],
            snapshot_enabled: true,
            encryption: "none".into(),
        };
        let fields = s.to_mqtt_fields();
        let members = fields.iter().find(|(k, _)| *k == "members").unwrap();
        assert_eq!(members.1, r#"[{"name":"alice","role":"admin"}]"#);
        let snap = fields
            .iter()
            .find(|(k, _)| *k == "snapshot_enabled")
            .unwrap();
        assert_eq!(snap.1, "true");
    }

    #[test]
    fn num_trims_integers() {
        assert_eq!(num(12.0), "12");
        assert_eq!(num(12.34), "12.34");
    }
}
