// js/player-rules.js
// Small rules of the player's bodies and the city's vehicles, kept free of the scene so they can be checked on their own.

// The helicopter's cruise speed (m/s) and how many times faster it goes with turbo held
const HELI_CRUISE_SPEED = 52.0;
const HELI_TURBO = 1.6;
// Turbo's share (0 to 1) moves this much per second, so it ramps in and out over a little under a second
const TURBO_RAMP = 1.2;

/** Turbo's next share: towards `held` (true, false or an analog 0..1) at TURBO_RAMP per second. */
function stepTurbo(current, held, dt) {
  const now = Number.isFinite(current) ? current : 0;
  const target = held ? Math.max(0, Math.min(1, Number(held))) : 0;
  const step = Math.max(0, Number.isFinite(dt) ? dt : 0) * TURBO_RAMP;
  return now + Math.max(-step, Math.min(step, target - now));
}

/** The helicopter's top forward speed for a turbo share: cruise at 0, HELI_TURBO times cruise at 1. */
function heliTopSpeed(turbo) {
  return HELI_CRUISE_SPEED * (1 + (HELI_TURBO - 1) * Math.max(0, Math.min(1, turbo || 0)));
}

/**
 * Where the next mode's body arrives when the player switches: under or at the one they leave, facing the same way.
 * From the air it drops straight down to the ground; a helicopter taken from the ground starts there, on the street.
 * The controller's findTeleportPosition() then moves it to the nearest spot clear of buildings, landmarks and the
 * other bodies. null when there is no place to start from.
 */
function arrivalFor(from, nextMode) {
  if (!from || !Number.isFinite(from.x) || !Number.isFinite(from.z)) return null;
  const heading = Number.isFinite(from.heading) ? from.heading : Math.PI;
  return { x: from.x, z: from.z, heading, altitude: nextMode === 'helicopter' ? 0.25 : null };
}

// Brake lamp level the car and bus materials read (their red scales with it): full while slowing down, dimmer when
// only held at a standstill, so a car braking stands out from the queue it joins. Two fixed steps, so the per-instance
// state changes only when a car starts or stops braking, not every frame.
const BRAKE_LAMP = { slowing: 1, holding: 0.6, slowingAt: -0.8, standingBelow: 0.3 };

/** The brake lamp level for a vehicle's acceleration (m/s^2) and speed (m/s). */
function brakeLamp(acceleration, speed) {
  if (acceleration < BRAKE_LAMP.slowingAt) return BRAKE_LAMP.slowing;
  return Math.abs(speed) < BRAKE_LAMP.standingBelow ? BRAKE_LAMP.holding : 0;
}

export { BRAKE_LAMP, HELI_CRUISE_SPEED, HELI_TURBO, arrivalFor, brakeLamp, heliTopSpeed, stepTurbo };
