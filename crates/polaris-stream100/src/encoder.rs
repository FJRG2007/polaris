//! Raw encoder counts to volume changes.
//!
//! The complaint this answers is "the volume goes up on its own, too much,
//! sometimes". Three causes are visible in how the counts arrive, and each has
//! its own guard here:
//!
//! 1. **Jitter.** A knob at rest can report a count or two back and forth. Added
//!    up blindly, that creeps until it crosses a step. Movements smaller than
//!    the dead band that reverse direction cancel out, and a partial step left
//!    alone for [`Tuning::settle_ms`] is dropped instead of kept.
//! 2. **Banked counts.** Counts turned while nothing was assigned to the knob
//!    (the app was closed) used to be applied all at once when it reopened.
//!    [`Encoder::discard`] throws them away; the caller does that whenever the
//!    knob has no target.
//! 3. **Runaway steps.** One report may carry a large delta after a USB stall.
//!    A single report never moves the volume more than [`Tuning::max_step`].
//!
//! Acceleration is deliberate and bounded: a fast spin moves further per
//! detent, a slow turn always moves exactly the configured amount.
//!
//! Time is passed in (milliseconds from any monotonic origin), so all of this
//! is deterministic and tested without a clock.

use serde::{Deserialize, Serialize};

/// Encoder counts between two detents, as measured on the hardware.
pub const DETENT_COUNTS: i32 = 48;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Tuning {
    /// Volume percent moved by one detent at slow speed.
    pub percent_per_detent: u8,
    /// Counts that never count as movement on their own.
    pub dead_band: u8,
    /// A partial step untouched this long is dropped.
    pub settle_ms: u32,
    /// Largest multiplier a fast spin reaches; 1 turns acceleration off.
    pub max_acceleration: u8,
    /// Most percent one report may move, whatever it carries.
    pub max_step: u8,
}

impl Default for Tuning {
    fn default() -> Self {
        Self {
            percent_per_detent: 2,
            dead_band: 3,
            settle_ms: 250,
            max_acceleration: 3,
            max_step: 10,
        }
    }
}

impl Tuning {
    /// The tuning with every field brought into its allowed range, so a stored
    /// value from an older or hand-edited file can never disable a guard.
    pub fn clamped(self) -> Self {
        Self {
            percent_per_detent: self.percent_per_detent.clamp(1, 10),
            dead_band: self.dead_band.clamp(0, 24),
            settle_ms: self.settle_ms.clamp(50, 2_000),
            max_acceleration: self.max_acceleration.clamp(1, 5),
            max_step: self.max_step.clamp(1, 25),
        }
    }

    fn counts_per_percent(&self) -> i32 {
        (DETENT_COUNTS / i32::from(self.percent_per_detent)).max(1)
    }
}

/// Spin speed, in counts per millisecond, where acceleration starts and where
/// it reaches its maximum. One detent per 100 ms is still a slow turn.
const ACCEL_FROM: f64 = DETENT_COUNTS as f64 / 60.0;
const ACCEL_FULL: f64 = DETENT_COUNTS as f64 / 12.0;

/// One knob's state between reports.
#[derive(Debug, Clone, Default)]
pub struct Encoder {
    pending: i32,
    last_ms: Option<u64>,
}

impl Encoder {
    /// Drops whatever was turned but not yet applied.
    pub fn discard(&mut self) {
        self.pending = 0;
        self.last_ms = None;
    }

    /// Feeds the counts of one report; answers the signed percent to apply now.
    pub fn turn(&mut self, counts: i32, now_ms: u64, tuning: &Tuning) -> i32 {
        let tuning = tuning.clamped();
        let elapsed = self.last_ms.map(|last| now_ms.saturating_sub(last));
        if elapsed.is_some_and(|ms| ms > u64::from(tuning.settle_ms)) {
            self.pending = 0;
        }
        self.last_ms = Some(now_ms);
        if counts == 0 {
            return 0;
        }
        // A small move against what is pending is jitter: it cancels the
        // pending remainder instead of starting a step the other way.
        let dead_band = i32::from(tuning.dead_band);
        if self.pending.signum() == -counts.signum() && counts.abs() <= dead_band {
            self.pending = 0;
            return 0;
        }
        if self.pending == 0 && counts.abs() <= dead_band {
            // Too small to be a turn by itself; keep it only as a start.
            self.pending = counts;
            return 0;
        }
        let multiplier = acceleration(counts, elapsed, tuning.max_acceleration);
        self.pending += counts * multiplier;
        let per_percent = tuning.counts_per_percent();
        let steps = self.pending / per_percent;
        if steps == 0 {
            return 0;
        }
        self.pending -= steps * per_percent;
        let max = i32::from(tuning.max_step);
        if steps.abs() > max {
            // A burst larger than any real turn: apply the cap, drop the rest.
            self.pending = 0;
            return steps.signum() * max;
        }
        steps
    }
}

fn acceleration(counts: i32, elapsed: Option<u64>, max: u8) -> i32 {
    let max = i32::from(max);
    let Some(ms) = elapsed.filter(|ms| *ms > 0) else {
        return 1;
    };
    let speed = f64::from(counts.abs()) / ms as f64;
    if speed <= ACCEL_FROM || max <= 1 {
        return 1;
    }
    let ratio = ((speed - ACCEL_FROM) / (ACCEL_FULL - ACCEL_FROM)).min(1.0);
    1 + (ratio * f64::from(max - 1)).round() as i32
}

/// Applies a change to a volume in percent, clamped to 0-100.
pub fn apply(volume: u8, change: i32) -> u8 {
    (i32::from(volume.min(100)) + change).clamp(0, 100) as u8
}
