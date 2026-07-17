//! MQTT topic layout.
//!
//! The topic tree is the contract between the on-device agent and the Home
//! Assistant entities. It is the single source of truth: the Python side is
//! generated from these segment names (see `examples/gen_python.rs`), so the
//! two ends can never drift. Layout: `unas/<id>/...` where `<id>` is the first
//! eight characters of the config entry id.

/// Topic segment names. Shared by [`Topics`] and the Python code generator so
/// both ends of the protocol stay identical.
pub mod seg {
    pub const PREFIX: &str = "unas";
    pub const AVAILABILITY: &str = "availability";
    pub const CONTROL: &str = "control";
    pub const SYSTEM: &str = "system";
    pub const HDD: &str = "hdd";
    pub const NVME: &str = "nvme";
    pub const POOL: &str = "pool";
    pub const SMB: &str = "smb";
    pub const NFS: &str = "nfs";
    pub const SHARE: &str = "share";
}

/// Root prefix for every topic belonging to one integration entry.
///
/// Only the first eight characters of the entry id are used, matching the
/// Python side.
pub fn root(entry_id: &str) -> String {
    let short: String = entry_id.chars().take(8).collect();
    format!("{}/{short}", seg::PREFIX)
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
        format!("{}/{}", self.root, seg::AVAILABILITY)
    }

    pub fn system(&self, metric: &str) -> String {
        format!("{}/{}/{metric}", self.root, seg::SYSTEM)
    }

    pub fn hdd(&self, bay: &str, metric: &str) -> String {
        format!("{}/{}/{bay}/{metric}", self.root, seg::HDD)
    }

    pub fn nvme(&self, slot: &str, metric: &str) -> String {
        format!("{}/{}/{slot}/{metric}", self.root, seg::NVME)
    }

    pub fn pool(&self, num: u32, metric: &str) -> String {
        format!("{}/{}/{num}/{metric}", self.root, seg::POOL)
    }

    pub fn share(&self, name: &str, metric: &str) -> String {
        format!("{}/{}/{name}/{metric}", self.root, seg::SHARE)
    }

    pub fn smb(&self, leaf: &str) -> String {
        format!("{}/{}/{leaf}", self.root, seg::SMB)
    }

    pub fn nfs(&self, leaf: &str) -> String {
        format!("{}/{}/{leaf}", self.root, seg::NFS)
    }

    /// Interval control topic the agent subscribes to for live re-tuning.
    pub fn monitor_interval(&self) -> String {
        format!("{}/{}/monitor_interval", self.root, seg::CONTROL)
    }

    /// Fan mode control topic (`unas_managed`, `auto`, `target_temp`, or a raw
    /// PWM integer for fixed speed).
    pub fn fan_mode(&self) -> String {
        format!("{}/{}/fan/mode", self.root, seg::CONTROL)
    }

    /// A single fan curve parameter (`min_temp`, `max_fan`, `target_temp`, ...).
    pub fn fan_curve(&self, param: &str) -> String {
        format!("{}/{}/fan/curve/{param}", self.root, seg::CONTROL)
    }

    /// Wildcard covering every fan curve parameter, for a single subscription.
    pub fn fan_curve_wildcard(&self) -> String {
        format!("{}/{}/fan/curve/+", self.root, seg::CONTROL)
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
