//! Agent configuration, read from the environment.
//!
//! The Home Assistant side writes these into a systemd `EnvironmentFile` at
//! deploy time. Unlike upstream, no credentials are string-substituted into a
//! script on disk; secrets stay in the env file that systemd owns.

use polaris_unas_core::bays::DeviceModel;

const DEFAULT_INTERVAL: u64 = 30;
const MIN_INTERVAL: u64 = 5;
const MAX_INTERVAL: u64 = 60;

#[derive(Debug, Clone)]
pub struct Config {
    pub mqtt_host: String,
    pub mqtt_port: u16,
    pub mqtt_user: String,
    pub mqtt_pass: String,
    /// Fully-formed topic root, e.g. `unas/abcdef01`.
    pub mqtt_root: String,
    pub model: DeviceModel,
    pub interval: u64,
}

fn env(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.is_empty())
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let mqtt_host = env("POLARIS_MQTT_HOST").ok_or("POLARIS_MQTT_HOST is required")?;
        let mqtt_root = env("POLARIS_MQTT_ROOT").ok_or("POLARIS_MQTT_ROOT is required")?;

        let mqtt_port = env("POLARIS_MQTT_PORT")
            .map(|p| {
                p.parse::<u16>()
                    .map_err(|_| "POLARIS_MQTT_PORT must be a port number")
            })
            .transpose()?
            .unwrap_or(1883);

        let interval = env("POLARIS_MONITOR_INTERVAL")
            .and_then(|v| v.parse::<u64>().ok())
            .unwrap_or(DEFAULT_INTERVAL)
            .clamp(MIN_INTERVAL, MAX_INTERVAL);

        Ok(Self {
            mqtt_host,
            mqtt_port,
            mqtt_user: env("POLARIS_MQTT_USER").unwrap_or_default(),
            mqtt_pass: env("POLARIS_MQTT_PASS").unwrap_or_default(),
            mqtt_root,
            model: DeviceModel::from_key(&env("POLARIS_DEVICE_MODEL").unwrap_or_default()),
            interval,
        })
    }
}

/// Clamp a live-updated interval to the supported range.
pub fn clamp_interval(v: u64) -> Option<u64> {
    (MIN_INTERVAL..=MAX_INTERVAL).contains(&v).then_some(v)
}
