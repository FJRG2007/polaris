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

// What a body carries frame to frame that ends up in its transform, the camera or the HUD. A non-finite one of these
// (NaN from a division by zero, or from a field a mode never set) would blank the view: three.js renders nothing
// through a NaN matrix and the HUD reads "NaN".
const BODY_MOTION = ['speed', 'verticalVel', 'verticalSpeed', 'vx', 'vz', 'angularVel', 'steerAngle', 'pitchVel',
  'rollVel', 'heaveY', 'heaveVel', 'leanAngle', 'pitchAngle', 'rollAngle', 'turbo'];

/** Whether a body's position and heading are all finite numbers. */
function bodyIsFinite(body) {
  const p = body?.position;
  return !!p && Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z) && Number.isFinite(body.heading);
}

/**
 * Keeps a body out of NaN. A body whose position and heading are finite becomes `last` (the place it is put back to);
 * one that is not is put back at `last` (or `fallback` before it has one) at rest, and any non-finite motion field is
 * zeroed. Returns the names of the fields that were repaired (empty when there was nothing to do).
 */
function settleBody(body, last, fallback = { x: 0, y: 0, z: 0, heading: Math.PI }) {
  const repaired = [];
  if (!body?.position) return repaired;
  const p = body.position;
  if (bodyIsFinite(body)) {
    if (last) Object.assign(last, { x: p.x, y: p.y, z: p.z, heading: body.heading });
  } else {
    for (const axis of ['x', 'y', 'z']) if (!Number.isFinite(p[axis])) repaired.push(axis);
    if (!Number.isFinite(body.heading)) repaired.push('heading');
    const to = last && Number.isFinite(last.x) ? last : fallback;
    p.x = to.x;
    p.y = to.y;
    p.z = to.z;
    body.heading = to.heading;
    for (const key of BODY_MOTION) if (key in body) body[key] = 0;
  }
  for (const key of BODY_MOTION) {
    if (key in body && typeof body[key] === 'number' && !Number.isFinite(body[key])) {
      body[key] = 0;
      repaired.push(key);
    }
  }
  return repaired;
}

/** A HUD readout: the number rounded, or "-" when there is no number to show (never "NaN"). */
function hudReadout(value, format = String) {
  return Number.isFinite(value) ? format(Math.round(value)) : '-';
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

// The player car signals from the steering held: a turn held at town speed starts the indicator on that side, and it
// cancels once the wheel has been straight a moment (or the car is up to speed), like a stalk returning after the corner.
// Same 0.8 s cycle as traffic. Side 1 is left (+x), -1 right.
const TURN_SIGNAL = { steerAbove: 0.5, holdFor: 0.25, cancelAfter: 0.6, minSpeed: 0.5, maxSpeed: 14, period: 0.8 };

function createTurnSignal() {
  return { side: 0, pending: 0, held: 0, straight: 0, clock: 0 };
}

/** Advances a turn signal by dt seconds of steering input (-1..1, positive left) at a speed in m/s. */
function stepTurnSignal(signal, steer, speed, dt) {
  const s = Math.abs(speed);
  const side = steer > TURN_SIGNAL.steerAbove ? 1 : steer < -TURN_SIGNAL.steerAbove ? -1 : 0;
  if (side !== 0 && s >= TURN_SIGNAL.minSpeed && s <= TURN_SIGNAL.maxSpeed) {
    signal.held = signal.pending === side ? signal.held + dt : dt;
    signal.pending = side;
    signal.straight = 0;
    if (signal.held >= TURN_SIGNAL.holdFor) signal.side = side;
  } else {
    signal.pending = 0;
    signal.held = 0;
    if (side === 0) signal.straight += dt;
    if (signal.straight >= TURN_SIGNAL.cancelAfter || s > TURN_SIGNAL.maxSpeed) signal.side = 0;
  }
  signal.clock = signal.side ? signal.clock + dt : 0;
  return signal;
}

/** The lamp levels { left, right } a turn signal shows this instant: lit for the first half of each cycle. */
function turnLamps(signal) {
  const on = signal.side !== 0 && signal.clock % TURN_SIGNAL.period < TURN_SIGNAL.period / 2;
  return { left: on && signal.side > 0 ? 1 : 0, right: on && signal.side < 0 ? 1 : 0 };
}

export {
  BODY_MOTION, BRAKE_LAMP, HELI_CRUISE_SPEED, HELI_TURBO, TURN_SIGNAL, arrivalFor, bodyIsFinite, brakeLamp, createTurnSignal,
  heliTopSpeed, hudReadout, settleBody, stepTurbo, stepTurnSignal, turnLamps
};
