//! MQTT topic layout.
//!
//! The topic tree is the contract between the on-device agent and the Home
//! Assistant entities. It mirrors the upstream layout exactly so existing HA
//! subscriptions keep working: `unas/<id>/...` where `<id>` is the first eight
//! characters of the config entry id.

/// Root prefix for every topic belonging to one integration entry.
///
/// Only the first eight characters of the entry id are used, matching upstream.
pub fn root(entry_id: &str) -> String {
    let short: String = entry_id.chars().take(8).collect();
    format!("unas/{short}")
}

/// The fixed set of topics derived from a root prefix.
#[derive(Debug, Clone)]
pub struct Topics {
    pub root: String,
}

impl Topics {
    pub fn new(entry_id: &str) -> Self {
        Self {
            root: root(entry_id),
        }
    }

    /// Build from a fully-formed root (e.g. `"unas/abcdef01"`), as supplied by
    /// the Home Assistant side, without re-prefixing.
    pub fn from_root(root: impl Into<String>) -> Self {
        Self { root: root.into() }
    }

    pub fn availability(&self) -> String {
        format!("{}/availability", self.root)
    }

    pub fn system(&self, metric: &str) -> String {
        format!("{}/system/{metric}", self.root)
    }

    pub fn hdd(&self, bay: &str, metric: &str) -> String {
        format!("{}/hdd/{bay}/{metric}", self.root)
    }

    pub fn nvme(&self, slot: &str, metric: &str) -> String {
        format!("{}/nvme/{slot}/{metric}", self.root)
    }

    pub fn pool(&self, num: u32, metric: &str) -> String {
        format!("{}/pool/{num}/{metric}", self.root)
    }

    pub fn share(&self, name: &str, metric: &str) -> String {
        format!("{}/share/{name}/{metric}", self.root)
    }

    pub fn smb(&self, leaf: &str) -> String {
        format!("{}/smb/{leaf}", self.root)
    }

    pub fn nfs(&self, leaf: &str) -> String {
        format!("{}/nfs/{leaf}", self.root)
    }

    /// Interval control topic the agent subscribes to for live re-tuning.
    pub fn monitor_interval(&self) -> String {
        format!("{}/control/monitor_interval", self.root)
    }

    /// Fan mode control topic (`unas_managed`, `auto`, `target_temp`, or a raw
    /// PWM integer for fixed speed).
    pub fn fan_mode(&self) -> String {
        format!("{}/control/fan/mode", self.root)
    }

    /// A single fan curve parameter (`min_temp`, `max_fan`, `target_temp`, ...).
    pub fn fan_curve(&self, param: &str) -> String {
        format!("{}/control/fan/curve/{param}", self.root)
    }

    /// Wildcard covering every fan curve parameter, for a single subscription.
    pub fn fan_curve_wildcard(&self) -> String {
        format!("{}/control/fan/curve/+", self.root)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_truncates_to_eight_chars() {
        assert_eq!(root("0123456789abcdef"), "unas/01234567");
        assert_eq!(root("short"), "unas/short");
    }

    #[test]
    fn topic_shapes() {
        let t = Topics::new("abcdef0123");
        assert_eq!(t.root, "unas/abcdef01");
        assert_eq!(t.hdd("6", "temperature"), "unas/abcdef01/hdd/6/temperature");
        assert_eq!(
            t.fan_curve("min_temp"),
            "unas/abcdef01/control/fan/curve/min_temp"
        );
        assert_eq!(t.availability(), "unas/abcdef01/availability");
    }
}
