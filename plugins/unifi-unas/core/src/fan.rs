//! Fan control algorithms.
//!
//! Ported from the upstream `fan_control.sh`, whose PI controller was written in
//! `awk` float math with state persisted through `sed` into a temp file. Here it
//! is plain `f64` with explicit state, which removes the shell fragility and
//! makes the control loop unit-testable.
//!
//! Rounding note: the shell used C `printf "%.0f"` (round half to even); this
//! port uses round half away from zero. The two differ only on exact `.5`
//! boundaries, a negligible one-PWM-step difference on a 0..255 fan output.

use std::collections::VecDeque;

const TREND_FALLING_FAST: f64 = -1.5;
const TREND_FALLING: f64 = 0.0;
const TREND_STABLE: f64 = 0.3;
const TEMP_HISTORY_SIZE: usize = 6;

/// How aggressively the target-temperature controller reacts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResponseSpeed {
    Relaxed,
    Balanced,
    Aggressive,
}

impl ResponseSpeed {
    pub fn multiplier(self) -> f64 {
        match self {
            Self::Relaxed => 0.5,
            Self::Balanced => 1.0,
            Self::Aggressive => 2.0,
        }
    }

    /// Parse the MQTT payload; anything unrecognised falls back to `Balanced`.
    pub fn from_payload(s: &str) -> Self {
        match s {
            "relaxed" => Self::Relaxed,
            "aggressive" => Self::Aggressive,
            _ => Self::Balanced,
        }
    }
}

/// PI controller gains and limits. Defaults mirror the upstream constants.
#[derive(Debug, Clone, Copy)]
pub struct PiConfig {
    pub kp: f64,
    pub ki: f64,
    pub max_rate: f64,
}

impl Default for PiConfig {
    fn default() -> Self {
        Self {
            kp: 10.0,
            ki: 0.05,
            max_rate: 5.0,
        }
    }
}

/// Linear temperature-to-PWM curve used by Custom Curve mode.
///
/// Fan speed scales linearly between `min_fan` and `max_fan` as the temperature
/// moves from `min_temp` to `max_temp`, clamped at both ends.
pub fn linear_curve(temp: f64, min_temp: f64, max_temp: f64, min_fan: u8, max_fan: u8) -> u8 {
    if temp <= min_temp {
        return min_fan;
    }
    if temp >= max_temp || max_temp <= min_temp {
        return max_fan;
    }
    let span = (max_fan as f64 - min_fan as f64) / (max_temp - min_temp);
    let value = min_fan as f64 + (temp - min_temp) * span;
    value.trunc().clamp(0.0, 255.0) as u8
}

/// Proportional-Integral controller that drives drives toward a target temp.
///
/// State (integral, last PWM, temperature trend) lives here between ticks. The
/// agent feeds a fresh temperature sample once per monitor cycle via
/// [`FanController::push_temp_sample`], then calls
/// [`FanController::target_temp_pwm`] on every fan tick.
#[derive(Debug, Clone)]
pub struct FanController {
    integral: f64,
    last_pwm: f64,
    has_run: bool,
    temp_history: VecDeque<f64>,
    trend_mult: f64,
    cfg: PiConfig,
    /// When true, decay below target uses the response-speed multiplier too;
    /// when false, decay always uses 1x (upstream `SYMMETRIC_DECAY`).
    pub symmetric_decay: bool,
}

impl Default for FanController {
    fn default() -> Self {
        Self {
            integral: 0.0,
            last_pwm: 0.0,
            has_run: false,
            temp_history: VecDeque::with_capacity(TEMP_HISTORY_SIZE),
            trend_mult: 1.0,
            cfg: PiConfig::default(),
            symmetric_decay: true,
        }
    }
}

impl FanController {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn integral(&self) -> f64 {
        self.integral
    }

    pub fn last_pwm(&self) -> f64 {
        self.last_pwm
    }

    pub fn trend_mult(&self) -> f64 {
        self.trend_mult
    }

    /// Seed the integral directly, used for warm starts and mode transitions.
    pub fn set_integral(&mut self, value: f64) {
        self.integral = value.max(0.0);
    }

    /// Clear the PI state when (re)entering target-temperature mode.
    pub fn reset(&mut self) {
        self.integral = 0.0;
        self.last_pwm = 0.0;
        self.has_run = false;
        self.temp_history.clear();
        self.trend_mult = 1.0;
    }

    /// Record a fresh temperature sample and recompute the rising/falling trend.
    ///
    /// Call once per monitor cycle (i.e. only when new data arrives), matching
    /// the upstream behaviour of sampling on temp-file updates rather than on
    /// every fan tick.
    pub fn push_temp_sample(&mut self, temp: f64) {
        self.temp_history.push_back(temp);
        if self.temp_history.len() > TEMP_HISTORY_SIZE {
            self.temp_history.pop_front();
        }
        if self.temp_history.len() < 3 {
            return; // not enough history yet; keep the previous trend
        }
        let oldest = *self.temp_history.front().unwrap();
        let newest = *self.temp_history.back().unwrap();
        let diff = newest - oldest;
        self.trend_mult = if diff <= TREND_FALLING_FAST {
            0.0
        } else if diff < TREND_FALLING {
            0.2
        } else if diff < TREND_STABLE {
            1.0
        } else {
            1.5
        };
    }

    /// Compute the next PWM value for target-temperature mode.
    ///
    /// `current_temp` is the chosen metric (max or average) in Celsius, `dt` the
    /// seconds since the previous tick. Returns a PWM in `0..=255` already
    /// clamped to `[min_fan, max_fan]`.
    pub fn target_temp_pwm(
        &mut self,
        current_temp: f64,
        target_temp: f64,
        min_fan: u8,
        max_fan: u8,
        dt: f64,
        speed: ResponseSpeed,
    ) -> u8 {
        let min_f = min_fan as f64;
        let max_f = max_fan as f64;
        let pi_max_integral = (max_f - min_f).max(0.0);

        // No valid reading (e.g. no drives) -> fall back to the floor.
        if current_temp <= 0.0 {
            return min_fan;
        }

        let baseline = min_f;
        let error = current_temp - target_temp;

        let dt = if self.has_run {
            dt.clamp(1.0, 10.0)
        } else {
            1.0
        };

        let p_term = (self.cfg.kp * error).round();

        let speed_mult = speed.multiplier();
        let accum_mult = self.trend_mult * speed_mult;
        let decay_mult = if self.symmetric_decay {
            speed_mult
        } else {
            1.0
        };

        // Anti-windup: freeze the integral while saturated high and still hot.
        let saturated_high = self.last_pwm >= max_f && error > 0.0;
        if !saturated_high {
            let mult = if error > 0.0 { accum_mult } else { decay_mult };
            let ni = self.integral + self.cfg.ki * error * dt * mult;
            self.integral = ni.clamp(0.0, pi_max_integral);
        }

        let mut new_pwm = (baseline + p_term + self.integral).round();

        // Rate limit relative to the previous output, once we have one.
        if self.last_pwm > 0.0 {
            let max_change = self.cfg.max_rate * dt;
            let diff = new_pwm - self.last_pwm;
            if diff > max_change {
                new_pwm = self.last_pwm + max_change;
            } else if diff < -max_change {
                new_pwm = self.last_pwm - max_change;
            }
        }

        new_pwm = new_pwm.clamp(min_f, max_f);
        self.last_pwm = new_pwm;
        self.has_run = true;

        new_pwm.clamp(0.0, 255.0) as u8
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn linear_curve_endpoints_and_midpoint() {
        assert_eq!(linear_curve(30.0, 40.0, 50.0, 64, 255), 64); // below min
        assert_eq!(linear_curve(60.0, 40.0, 50.0, 64, 255), 255); // above max
        assert_eq!(linear_curve(45.0, 40.0, 50.0, 64, 255), 159); // midpoint: 64 + 0.5*191 = 159.5 -> trunc 159
    }

    #[test]
    fn linear_curve_degenerate_range_is_safe() {
        // Inverted range (min > max) must never divide by zero. Below min -> floor,
        // above max -> ceiling; both ends stay clamped and valid.
        assert_eq!(linear_curve(45.0, 50.0, 40.0, 64, 255), 64);
        assert_eq!(linear_curve(55.0, 50.0, 40.0, 64, 255), 255);
    }

    #[test]
    fn at_target_holds_at_floor_on_first_tick() {
        let mut fc = FanController::new();
        assert_eq!(
            fc.target_temp_pwm(40.0, 40.0, 64, 255, 1.0, ResponseSpeed::Balanced),
            64
        );
    }

    #[test]
    fn no_drives_returns_min_fan() {
        let mut fc = FanController::new();
        assert_eq!(
            fc.target_temp_pwm(0.0, 40.0, 64, 255, 1.0, ResponseSpeed::Balanced),
            64
        );
    }

    #[test]
    fn rate_limit_caps_change_between_ticks() {
        let mut fc = FanController::new();
        // First tick establishes a baseline last_pwm at the floor.
        assert_eq!(
            fc.target_temp_pwm(40.0, 40.0, 64, 255, 1.0, ResponseSpeed::Balanced),
            64
        );
        // A big jump is capped to max_rate * dt = 5 above the previous output.
        assert_eq!(
            fc.target_temp_pwm(80.0, 40.0, 64, 255, 1.0, ResponseSpeed::Balanced),
            69
        );
    }

    #[test]
    fn integral_decays_when_below_target() {
        let mut fc = FanController::new();
        fc.set_integral(50.0);
        // Below target with a warmed-up controller: integral should shrink.
        fc.target_temp_pwm(45.0, 40.0, 64, 255, 1.0, ResponseSpeed::Balanced); // above, grows a hair
        let before = fc.integral();
        let cool = fc.integral();
        fc.target_temp_pwm(35.0, 40.0, 64, 255, 1.0, ResponseSpeed::Balanced); // below target
        assert!(fc.integral() < cool.max(before));
    }

    #[test]
    fn trend_detects_rising_and_falling() {
        let mut fc = FanController::new();
        for t in [40.0, 42.0, 44.0] {
            fc.push_temp_sample(t);
        }
        assert_eq!(fc.trend_mult(), 1.5); // rising

        let mut fc = FanController::new();
        for t in [46.0, 44.0, 42.0] {
            fc.push_temp_sample(t);
        }
        assert_eq!(fc.trend_mult(), 0.0); // falling fast
    }

    #[test]
    fn reset_clears_state() {
        let mut fc = FanController::new();
        fc.target_temp_pwm(80.0, 40.0, 64, 255, 1.0, ResponseSpeed::Aggressive);
        fc.push_temp_sample(50.0);
        fc.reset();
        assert_eq!(fc.integral(), 0.0);
        assert_eq!(fc.last_pwm(), 0.0);
        assert_eq!(fc.trend_mult(), 1.0);
    }
}
