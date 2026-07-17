//! Fan control: MQTT-driven settings, mode dispatch and PWM output.
//!
//! Unifies the upstream `fan_control.sh` into the agent process. Temperature
//! samples arrive in memory from the monitor loop rather than through a `/tmp`
//! handoff file, and the PI math lives in `polaris_unas_core::fan`.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::Path;
use std::time::Instant;

use polaris_unas_core::fan::{linear_curve, FanController, ResponseSpeed};
use polaris_unas_core::mqtt::Topics;

use crate::config::clamp_interval;
use crate::util::{log, read_trim};

const PWM1: &str = "/sys/class/hwmon/hwmon0/pwm1";
const KP: i64 = 10; // proportional gain, mirrors core PiConfig default

/// Live control settings, updated from retained MQTT messages published by
/// Home Assistant. Defaults mirror the upstream fan controller.
#[derive(Debug, Clone)]
pub struct ControlState {
    pub monitor_interval: u64,
    pub fan_mode: String,
    pub min_temp: i64,
    pub max_temp: i64,
    pub min_fan: u8,
    pub max_fan: u8,
    pub target_temp: i64,
    pub temp_metric: String,
    pub response_speed: String,
}

impl Default for ControlState {
    fn default() -> Self {
        Self {
            monitor_interval: 30,
            fan_mode: "unas_managed".into(),
            min_temp: 40,
            max_temp: 50,
            min_fan: 64,
            max_fan: 255,
            target_temp: 42,
            temp_metric: "max".into(),
            response_speed: "balanced".into(),
        }
    }
}

/// Apply one control message. Values that fail validation are ignored, matching
/// the upstream guard rails.
pub fn apply_control(state: &mut ControlState, topics: &Topics, topic: &str, payload: &str) {
    let as_int = || payload.parse::<f64>().ok().map(|v| v as i64);

    if topic == topics.monitor_interval() {
        if let Some(v) = payload
            .parse::<f64>()
            .ok()
            .map(|v| v as u64)
            .and_then(clamp_interval)
        {
            state.monitor_interval = v;
        }
    } else if topic == topics.fan_mode() {
        state.fan_mode = payload.to_string();
    } else if topic == topics.fan_curve("min_temp") {
        if let Some(v) = as_int() {
            state.min_temp = v;
        }
    } else if topic == topics.fan_curve("max_temp") {
        if let Some(v) = as_int() {
            state.max_temp = v;
        }
    } else if topic == topics.fan_curve("min_fan") {
        if let Some(v) = as_int() {
            state.min_fan = v.clamp(0, 255) as u8;
        }
    } else if topic == topics.fan_curve("max_fan") {
        if let Some(v) = as_int() {
            state.max_fan = v.clamp(0, 255) as u8;
        }
    } else if topic == topics.fan_curve("target_temp") {
        if let Some(v) = as_int() {
            state.target_temp = v;
        }
    } else if topic == topics.fan_curve("temp_metric") {
        if payload == "max" || payload == "avg" {
            state.temp_metric = payload.to_string();
        }
    } else if topic == topics.fan_curve("response_speed")
        && matches!(payload, "relaxed" | "balanced" | "aggressive")
    {
        state.response_speed = payload.to_string();
    }
}

/// Snapshot of the latest drive temperatures, sorted hottest-first, with a
/// generation counter so the fan loop can tell fresh readings from repeats.
#[derive(Debug, Clone, Default)]
pub struct TempsSnapshot {
    pub temps: Vec<i64>,
    pub generation: u64,
}

pub struct FanLoop {
    controller: FanController,
    channels: Vec<String>,
    prev_mode: String,
    prev_target: Option<i64>,
    last_seen_gen: u64,
    last_pwm_pub: Option<i64>,
    last_tick: Option<Instant>,
}

impl FanLoop {
    pub fn new() -> Self {
        Self {
            controller: FanController::new(),
            channels: detect_pwm_channels(),
            prev_mode: String::new(),
            prev_target: None,
            last_seen_gen: 0,
            last_pwm_pub: None,
            last_tick: None,
        }
    }

    /// One control tick. Computes the PWM for the active mode, writes it to the
    /// fan channels (except UNAS-managed, which only reports), and calls
    /// `publish` when the resulting fan speed changed.
    pub fn tick(
        &mut self,
        ctl: &ControlState,
        temps: &TempsSnapshot,
        mut publish: impl FnMut(i64),
    ) {
        let new_sample = temps.generation != self.last_seen_gen;
        self.last_seen_gen = temps.generation;

        let dt = self
            .last_tick
            .map(|t| t.elapsed().as_secs_f64())
            .unwrap_or(1.0);
        self.last_tick = Some(Instant::now());

        let hottest = temps.temps.first().copied().unwrap_or(0);
        let metric_temp = if ctl.temp_metric == "avg" && !temps.temps.is_empty() {
            temps.temps.iter().sum::<i64>() as f64 / temps.temps.len() as f64
        } else {
            hottest as f64
        };

        if new_sample {
            self.controller.push_temp_sample(metric_temp);
        }

        self.handle_target_change(ctl, metric_temp);
        self.handle_mode_transition(ctl, metric_temp);

        let pwm: i64 = match ctl.fan_mode.as_str() {
            "unas_managed" => current_pwm(),
            "auto" => {
                let p = linear_curve(
                    hottest as f64,
                    ctl.min_temp as f64,
                    ctl.max_temp as f64,
                    ctl.min_fan,
                    ctl.max_fan,
                );
                self.set_pwm(p);
                p as i64
            }
            "target_temp" => {
                let p = if metric_temp <= 0.0 {
                    ctl.min_fan
                } else {
                    let speed = ResponseSpeed::from_payload(&ctl.response_speed);
                    self.controller.target_temp_pwm(
                        metric_temp,
                        ctl.target_temp as f64,
                        ctl.min_fan,
                        ctl.max_fan,
                        dt,
                        speed,
                    )
                };
                self.set_pwm(p);
                p as i64
            }
            other => match other.parse::<u8>() {
                Ok(v) => {
                    self.set_pwm(v);
                    v as i64
                }
                Err(_) => current_pwm(), // invalid mode: leave fans to UNAS
            },
        };

        self.prev_mode = ctl.fan_mode.clone();
        self.prev_target = Some(ctl.target_temp);

        if self.last_pwm_pub != Some(pwm) {
            publish(pwm);
            self.last_pwm_pub = Some(pwm);
        }
    }

    /// When the target moves and the drives are already below it, damp the
    /// integral so the fans do not overshoot downward (upstream behaviour).
    fn handle_target_change(&mut self, ctl: &ControlState, metric_temp: f64) {
        if let Some(prev) = self.prev_target {
            if prev != ctl.target_temp && metric_temp < ctl.target_temp as f64 {
                self.controller
                    .set_integral(self.controller.integral() * 0.25);
            }
        }
    }

    /// On entering target-temperature mode, reset the controller and warm-start
    /// the integral from the current hardware PWM for a smooth handover.
    fn handle_mode_transition(&mut self, ctl: &ControlState, metric_temp: f64) {
        if ctl.fan_mode == "target_temp" && self.prev_mode != "target_temp" {
            self.controller.reset();
            let current = current_pwm();
            if current > ctl.min_fan as i64 {
                let expected_p = ((metric_temp as i64 - ctl.target_temp) * KP).max(0);
                let span = (ctl.max_fan as i64 - ctl.min_fan as i64).max(0);
                let calc = (current - ctl.min_fan as i64 - expected_p).clamp(0, span);
                if calc > 0 {
                    self.controller.set_integral(calc as f64);
                }
            }
        }
    }

    fn set_pwm(&self, value: u8) {
        for ch in &self.channels {
            if let Ok(mut f) = OpenOptions::new().write(true).open(ch) {
                let _ = write!(f, "{value}");
            }
        }
    }
}

fn current_pwm() -> i64 {
    read_trim(PWM1).and_then(|s| s.parse().ok()).unwrap_or(0)
}

/// Writable PWM channels on hwmon0. UNAS Pro/Pro 8 expose pwm1+pwm2 (adt7475);
/// single-fan models expose only pwm1.
fn detect_pwm_channels() -> Vec<String> {
    let mut channels = Vec::new();
    for i in 1..=9 {
        let path = format!("/sys/class/hwmon/hwmon0/pwm{i}");
        if Path::new(&path).exists() && OpenOptions::new().write(true).open(&path).is_ok() {
            channels.push(path);
        }
    }
    if channels.is_empty() {
        log("WARNING: no writable PWM channels found; fan control will be a no-op");
    }
    channels
}

#[cfg(test)]
mod tests {
    use super::*;

    fn topics() -> Topics {
        Topics::from_root("unas/abcd1234")
    }

    #[test]
    fn control_updates_valid_values() {
        let mut s = ControlState::default();
        let t = topics();
        apply_control(&mut s, &t, &t.fan_curve("min_fan"), "80");
        apply_control(&mut s, &t, &t.fan_curve("response_speed"), "aggressive");
        apply_control(&mut s, &t, &t.monitor_interval(), "15");
        assert_eq!(s.min_fan, 80);
        assert_eq!(s.response_speed, "aggressive");
        assert_eq!(s.monitor_interval, 15);
    }

    #[test]
    fn control_rejects_invalid_values() {
        let mut s = ControlState::default();
        let t = topics();
        apply_control(&mut s, &t, &t.fan_curve("response_speed"), "turbo"); // invalid
        apply_control(&mut s, &t, &t.monitor_interval(), "1"); // below min
        assert_eq!(s.response_speed, "balanced");
        assert_eq!(s.monitor_interval, 30);
    }
}
