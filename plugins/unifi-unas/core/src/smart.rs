//! Parsing of `smartctl -a -j` output into drive models.
//!
//! Ported field-for-field from the upstream Python so drive attributes reach
//! Home Assistant unchanged. Uses `serde_json::Value` navigation because the
//! smartctl schema is loosely typed (vendor-packed raw attribute strings, etc.).

use serde_json::Value;

use crate::model::{HddDrive, NvmeDrive};

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

fn get_str(v: &Value, key: &str) -> Option<String> {
    v.get(key).and_then(Value::as_str).map(str::to_owned)
}

/// String getter that treats empty strings as absent, mirroring Python's `or`.
fn get_nonempty(v: &Value, key: &str) -> Option<String> {
    get_str(v, key).filter(|s| !s.is_empty())
}

fn total_size_tb(v: &Value) -> f64 {
    let bytes = v
        .get("user_capacity")
        .and_then(|c| c.get("bytes"))
        .and_then(Value::as_f64)
        .unwrap_or(0.0);
    round2(bytes / 1_000_000_000_000.0)
}

/// Parse a spinning/SATA drive. Returns `Ok(None)` when the drive should be
/// skipped (SMART error or missing status), matching the upstream `continue`.
pub fn parse_hdd(json: &str, bay: String) -> Result<Option<HddDrive>, serde_json::Error> {
    let v: Value = serde_json::from_str(json)?;

    if v.get("error").is_some() {
        return Ok(None);
    }
    let smart_status = match v.get("smart_status") {
        Some(s) if s.is_object() => s,
        _ => return Ok(None),
    };
    let passed = smart_status
        .get("passed")
        .and_then(Value::as_bool)
        .unwrap_or(false);

    let serial = get_str(&v, "serial_number").unwrap_or_else(|| "Unknown".into());
    let model = get_nonempty(&v, "model_name")
        .or_else(|| get_str(&v, "product"))
        .unwrap_or_else(|| "Unknown".into());
    let firmware = get_str(&v, "firmware_version").unwrap_or_else(|| "Unknown".into());

    let temperature = v
        .get("temperature")
        .and_then(|t| t.get("current"))
        .and_then(Value::as_i64)
        .unwrap_or(0);

    let rotation = v.get("rotation_rate").and_then(Value::as_i64).unwrap_or(0);
    let rpm = (rotation > 0).then_some(rotation);

    let decoded_poh = v
        .get("power_on_time")
        .and_then(|p| p.get("hours"))
        .and_then(Value::as_i64);

    let mut power_on_hours: Option<i64> = None;
    let mut bad_sectors: Option<i64> = None;

    if let Some(table) = v
        .get("ata_smart_attributes")
        .and_then(|a| a.get("table"))
        .and_then(Value::as_array)
    {
        for attr in table {
            let name = attr
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            match name.as_str() {
                "power_on_hours" => {
                    power_on_hours = decoded_poh.filter(|h| *h >= 0).or_else(|| {
                        let raw = attr.get("raw");
                        // raw.string looks like "40311 (52 181 0)": take the first token.
                        let from_string = raw
                            .and_then(|r| r.get("string"))
                            .and_then(Value::as_str)
                            .and_then(|s| s.split_whitespace().next())
                            .and_then(|t| t.parse::<i64>().ok());
                        from_string
                            .or_else(|| raw.and_then(|r| r.get("value")).and_then(Value::as_i64))
                    });
                }
                "reallocated_sector_ct" => {
                    bad_sectors = Some(
                        attr.get("raw")
                            .and_then(|r| r.get("value"))
                            .and_then(Value::as_i64)
                            .unwrap_or(0),
                    );
                }
                _ => {}
            }
        }
    }

    let bad_sectors = bad_sectors.unwrap_or(0);
    let power_on_hours = power_on_hours.unwrap_or_else(|| decoded_poh.unwrap_or(0));

    Ok(Some(HddDrive {
        bay,
        model,
        serial,
        firmware,
        status: if passed {
            "Optimal".into()
        } else {
            "Warning".into()
        },
        temperature,
        rpm,
        power_on_hours,
        bad_sectors,
        total_size: total_size_tb(&v),
    }))
}

/// Parse an NVMe drive. Returns `Ok(None)` on a SMART error, matching upstream.
pub fn parse_nvme(json: &str, slot: String) -> Result<Option<NvmeDrive>, serde_json::Error> {
    let v: Value = serde_json::from_str(json)?;
    if v.get("error").is_some() {
        return Ok(None);
    }

    let health = v
        .get("nvme_smart_health_information_log")
        .cloned()
        .unwrap_or(Value::Null);
    let h_i64 =
        |key: &str, default: i64| health.get(key).and_then(Value::as_i64).unwrap_or(default);

    let available_spare = h_i64("available_spare", 100);
    let critical_warning = h_i64("critical_warning", 0);
    let status = if critical_warning != 0 || available_spare < 10 {
        "Warning"
    } else {
        "Optimal"
    };

    Ok(Some(NvmeDrive {
        slot,
        model: get_str(&v, "model_name").unwrap_or_else(|| "Unknown".into()),
        serial: get_str(&v, "serial_number").unwrap_or_else(|| "Unknown".into()),
        firmware: get_str(&v, "firmware_version").unwrap_or_else(|| "Unknown".into()),
        status: status.into(),
        temperature: h_i64("temperature", 0),
        power_on_hours: h_i64("power_on_hours", 0),
        percentage_used: h_i64("percentage_used", 0),
        available_spare,
        media_errors: h_i64("media_errors", 0),
        unsafe_shutdowns: h_i64("unsafe_shutdowns", 0),
        total_size: total_size_tb(&v),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skips_drive_with_error() {
        let json = r#"{"error": "no such device"}"#;
        assert!(parse_hdd(json, "1".into()).unwrap().is_none());
    }

    #[test]
    fn parses_hdd_core_fields() {
        let json = r#"{
            "smart_status": {"passed": true},
            "serial_number": "ABC123",
            "model_name": "WD Red",
            "firmware_version": "82.00A82",
            "temperature": {"current": 38},
            "rotation_rate": 5400,
            "power_on_time": {"hours": 12000},
            "user_capacity": {"bytes": 4000787030016},
            "ata_smart_attributes": {"table": [
                {"name": "Reallocated_Sector_Ct", "raw": {"value": 0}}
            ]}
        }"#;
        let d = parse_hdd(json, "6".into()).unwrap().unwrap();
        assert_eq!(d.bay, "6");
        assert_eq!(d.serial, "ABC123");
        assert_eq!(d.status, "Optimal");
        assert_eq!(d.temperature, 38);
        assert_eq!(d.rpm, Some(5400));
        assert_eq!(d.power_on_hours, 12000);
        assert_eq!(d.bad_sectors, 0);
        assert_eq!(d.total_size, 4.0);
    }

    #[test]
    fn power_on_hours_falls_back_to_raw_string() {
        let json = r#"{
            "smart_status": {"passed": false},
            "user_capacity": {"bytes": 0},
            "ata_smart_attributes": {"table": [
                {"name": "Power_On_Hours", "raw": {"string": "40311 (52 181 0)", "value": 123}}
            ]}
        }"#;
        let d = parse_hdd(json, "1".into()).unwrap().unwrap();
        assert_eq!(d.status, "Warning");
        assert_eq!(d.power_on_hours, 40311);
    }

    #[test]
    fn nvme_warning_on_low_spare() {
        let json = r#"{
            "model_name": "Samsung 980",
            "serial_number": "N1",
            "firmware_version": "1B2QEXM7",
            "user_capacity": {"bytes": 1000204886016},
            "nvme_smart_health_information_log": {
                "temperature": 45, "available_spare": 5, "percentage_used": 3,
                "media_errors": 0, "unsafe_shutdowns": 1, "power_on_hours": 500
            }
        }"#;
        let d = parse_nvme(json, "0".into()).unwrap().unwrap();
        assert_eq!(d.status, "Warning");
        assert_eq!(d.temperature, 45);
        assert_eq!(d.total_size, 1.0);
    }
}
