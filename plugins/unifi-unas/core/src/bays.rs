//! Physical bay mapping per device model.
//!
//! UNAS enumerates drives by their ATA link number, which does not match the
//! silkscreened bay labels on the chassis. Each supported model ships a lookup
//! from ATA number to the bay the user actually sees. Mappings for UNVR models
//! are community-reported (issue #11 upstream) and marked unofficial.

/// Supported device models. The string form matches the upstream config keys
/// so the Home Assistant side and the MQTT topics stay compatible.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeviceModel {
    UnasPro,
    UnasPro8,
    UnasPro4,
    Unas4,
    Unas2,
    Unvr,
    UnvrPro,
}

impl DeviceModel {
    /// Parse the upstream config key (e.g. `"UNAS_PRO"`). Unknown keys fall back
    /// to `UnasPro`, matching the original default.
    pub fn from_key(key: &str) -> Self {
        match key {
            "UNAS_PRO" => Self::UnasPro,
            "UNAS_PRO_8" => Self::UnasPro8,
            "UNAS_PRO_4" => Self::UnasPro4,
            "UNAS_4" => Self::Unas4,
            "UNAS_2" => Self::Unas2,
            "UNVR" => Self::Unvr,
            "UNVR_PRO" => Self::UnvrPro,
            _ => Self::UnasPro,
        }
    }

    pub fn as_key(self) -> &'static str {
        match self {
            Self::UnasPro => "UNAS_PRO",
            Self::UnasPro8 => "UNAS_PRO_8",
            Self::UnasPro4 => "UNAS_PRO_4",
            Self::Unas4 => "UNAS_4",
            Self::Unas2 => "UNAS_2",
            Self::Unvr => "UNVR",
            Self::UnvrPro => "UNVR_PRO",
        }
    }

    /// UNVR/UNVR Pro are video recorders, not NAS units: they lack SMB, NFS and
    /// shares, and report a Protect version instead of a Drive version.
    pub fn is_unvr(self) -> bool {
        matches!(self, Self::Unvr | Self::UnvrPro)
    }

    /// Map an ATA link number to the physical bay label, if this model knows it.
    ///
    /// `(ata, bay)` pairs; both are the numeric strings used upstream so the
    /// resulting MQTT topics (`hdd/<bay>/...`) remain byte-for-byte compatible.
    pub fn ata_to_bay(self, ata: &str) -> Option<&'static str> {
        let table: &[(&str, &str)] = match self {
            Self::UnasPro | Self::UnvrPro => &[
                ("1", "6"),
                ("3", "7"),
                ("4", "3"),
                ("5", "5"),
                ("6", "2"),
                ("7", "4"),
                ("8", "1"),
            ],
            Self::UnasPro8 => &[
                ("1", "1"),
                ("2", "2"),
                ("3", "3"),
                ("4", "4"),
                ("5", "5"),
                ("6", "6"),
                ("7", "7"),
                ("8", "8"),
            ],
            Self::UnasPro4 | Self::Unas4 => &[("1", "1"), ("2", "2"), ("3", "3"), ("4", "4")],
            Self::Unas2 => &[("1", "1"), ("2", "2")],
            Self::Unvr => &[("1", "3"), ("3", "4"), ("5", "2"), ("7", "1")],
        };
        table.iter().find(|(a, _)| *a == ata).map(|(_, bay)| *bay)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unas_pro_mapping_matches_upstream() {
        assert_eq!(DeviceModel::UnasPro.ata_to_bay("1"), Some("6"));
        assert_eq!(DeviceModel::UnasPro.ata_to_bay("8"), Some("1"));
        assert_eq!(DeviceModel::UnasPro.ata_to_bay("2"), None);
    }

    #[test]
    fn unknown_key_defaults_to_unas_pro() {
        assert_eq!(DeviceModel::from_key("something"), DeviceModel::UnasPro);
    }

    #[test]
    fn unvr_flag() {
        assert!(DeviceModel::Unvr.is_unvr());
        assert!(!DeviceModel::UnasPro.is_unvr());
    }
}
