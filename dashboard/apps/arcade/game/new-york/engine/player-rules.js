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

/** Whether a place { x, y, z, heading } is whole and finite. */
const placeIsFinite = (place) => !!place && ['x', 'y', 'z', 'heading'].every((key) => Number.isFinite(place[key]));

/**
 * Keeps a body out of NaN. A body whose position and heading are finite becomes `last` (the place it is put back to);
 * one that is not is put back at `last` (or `fallback` while `last` is not a whole finite place, else the origin) at
 * rest, and any non-finite motion field is zeroed. Returns the names of the fields that were repaired (empty when there
 * was nothing to do).
 */
function settleBody(body, last, fallback) {
  const repaired = [];
  if (!body?.position) return repaired;
  const p = body.position;
  if (bodyIsFinite(body)) {
    if (last) Object.assign(last, { x: p.x, y: p.y, z: p.z, heading: body.heading });
  } else {
    for (const axis of ['x', 'y', 'z']) if (!Number.isFinite(p[axis])) repaired.push(axis);
    if (!Number.isFinite(body.heading)) repaired.push('heading');
    const to = [last, fallback].find(placeIsFinite) ?? { x: 0, y: 0, z: 0, heading: Math.PI };
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

// ---------------------------------------------------------------------------------------------------------------------
// On foot: the over-the-shoulder camera, first person, and how the body moves under them. Angles follow the bodies'
// heading: yaw 0 looks along +z, a larger yaw turns left (towards +x), and pitch is positive looking up.

const PERSON_CAMERA = {
  pivotHeight: 1.55,   // m above the feet the arm hangs from: the shoulders of a 1.8 m body
  shoulder: 0.5,       // m to the right of the pivot, so the body sits left of centre and the street ahead stays clear
  distance: 3.3,       // m of arm behind the shoulder at zoom 1
  minArm: 0.35,        // the arm never gets shorter than this, however close the wall
  probe: 0.25,         // m kept between the lens and anything it would otherwise touch
  eyeHeight: 1.66,     // first person: the eyes of the same body, over its centre so the 0.48 m collider keeps walls off
  pitch: -0.1,         // the resting pitch: a little down, the camera about 1.9 m up
  thirdPitch: [-1.2, 0.85],
  firstPitch: [-1.45, 1.45],
  fov: { third: 52, first: 62 }, // vertical degrees: about 80 and 91 horizontal at 16:9
  near: 0.1,           // m; reversed float depth keeps the precision, and a wall at arm's length is not cut open
  followRate: 14,      // 1/s the pivot closes on the body horizontally
  followRateY: 7,      // 1/s vertically, so a jump or a curb is not a jolt
  armReturnRate: 3.5,  // 1/s the arm grows back out once a wall is passed (it shortens instantly)
  recenterAfter: 2.5,  // s with no look input before the camera drifts back behind a moving body
  recenterRate: 1.2,   // 1/s
  mouse: 0.0022,       // rad per pixel under pointer lock at sensitivity 1
  drag: 0.0055,        // rad per pixel of a drag or a touch swipe
  pad: { yaw: 3.4, pitch: 2.1, curve: 2 } // rad/s at full stick, and the response exponent past the deadzone
};

const PERSON_MOVE = {
  run: 5.8,          // m/s at full stick or with a key held
  sprint: 8.2,       // m/s with Shift / L3, the old top speed
  accel: 24,         // m/s^2 towards the wanted velocity on the ground
  decel: 30,         // m/s^2 when letting go
  airControl: 0.3,   // share of that acceleration in the air
  turnRate: 11,      // rad/s cap on how fast the body swings round to face where it goes
  turnSmooth: 16,    // 1/s exponential approach under that cap
  jumpSpeed: 5.2,
  gravity: 14.5,
  coyote: 0.12,      // s after walking off a curb a jump still counts
  buffer: 0.15       // s a press before landing is kept for the landing
};

const LOOK_SENSITIVITY = { min: 0.25, max: 2.5, fallback: 1 };

/** A look sensitivity read back from storage or a slider, kept within range; anything else is the default. */
function clampSensitivity(value) {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || n <= 0) return LOOK_SENSITIVITY.fallback;
  return Math.max(LOOK_SENSITIVITY.min, Math.min(LOOK_SENSITIVITY.max, n));
}

/** An angle wrapped into (-PI, PI]. */
function wrapAngle(a) {
  if (!Number.isFinite(a)) return 0;
  const r = a - Math.PI * 2 * Math.floor((a + Math.PI) / (Math.PI * 2));
  return r === -Math.PI ? Math.PI : r;
}

/**
 * The world direction an input asks for, relative to the camera's yaw: forward/back along the view, left/right across
 * it. Each input is -1..1; the result's `amount` is 0..1 (a diagonal is not faster) and x/z are a unit vector.
 */
function cameraRelativeMove(forward, right, yaw) {
  const f = Number.isFinite(forward) ? forward : 0;
  const r = Number.isFinite(right) ? right : 0;
  const length = Math.hypot(f, r);
  if (length < 1e-4) return { x: 0, z: 0, amount: 0 };
  const fx = Math.sin(yaw), fz = Math.cos(yaw);
  // The camera's right, with a larger yaw turning left: (-cos, sin)
  const x = (fx * f - fz * r) / length;
  const z = (fz * f + fx * r) / length;
  return { x, z, amount: Math.min(1, length) };
}

/** `current` turned towards `target` the short way round, exponentially but never faster than `maxRate` rad/s. */
function turnToward(current, target, dt, maxRate = PERSON_MOVE.turnRate, smooth = PERSON_MOVE.turnSmooth) {
  if (!(dt > 0)) return current;
  const delta = wrapAngle(target - current);
  const eased = delta * (1 - Math.exp(-smooth * dt));
  const cap = maxRate * dt;
  return current + Math.max(-cap, Math.min(cap, eased));
}

/** A planar velocity moved towards the wanted one by at most `rate` x dt (m/s): the acceleration and braking curve. */
function approachVelocity(vx, vz, wantX, wantZ, rate, dt) {
  const dx = wantX - vx, dz = wantZ - vz;
  const gap = Math.hypot(dx, dz);
  const step = Math.max(0, rate * (dt > 0 ? dt : 0));
  if (gap <= step || gap < 1e-9) return { vx: wantX, vz: wantZ };
  return { vx: vx + dx / gap * step, vz: vz + dz / gap * step };
}

/** Jump timing state: coyote time left, buffered press left, and whether the button was down last frame. */
function createJumpState() {
  return { coyote: 0, buffer: 0, held: false };
}

/**
 * One frame of jump timing. A press is remembered for PERSON_MOVE.buffer seconds, and the ground for PERSON_MOVE.coyote
 * seconds after leaving it; a jump fires when both overlap, and spends both (so holding the button does not bounce).
 * Returns whether to jump this frame.
 */
function stepJump(state, grounded, pressed, dt) {
  const step = dt > 0 ? dt : 0;
  if (pressed && !state.held) state.buffer = PERSON_MOVE.buffer;
  else state.buffer = Math.max(0, state.buffer - step);
  state.held = !!pressed;
  if (grounded) state.coyote = PERSON_MOVE.coyote;
  else state.coyote = Math.max(0, state.coyote - step);
  if (state.buffer > 0 && state.coyote > 0) {
    state.buffer = 0;
    state.coyote = 0;
    return true;
  }
  return false;
}

/** A look { yaw, pitch } turned by the given amounts, pitch held inside the view's limits. */
function turnLook(look, dYaw, dPitch, view = 'third') {
  const [lo, hi] = view === 'first' ? PERSON_CAMERA.firstPitch : PERSON_CAMERA.thirdPitch;
  look.yaw = wrapAngle(look.yaw + (Number.isFinite(dYaw) ? dYaw : 0));
  look.pitch = Math.max(lo, Math.min(hi, look.pitch + (Number.isFinite(dPitch) ? dPitch : 0)));
  return look;
}

/** A stick's look past its (already removed) radial deadzone, shaped so small tilts aim finely: x, y in -1..1. */
function lookCurve(x, y, exponent = PERSON_CAMERA.pad.curve) {
  const m = Math.hypot(x || 0, y || 0);
  if (!(m > 0)) return { x: 0, y: 0 };
  const shaped = Math.pow(Math.min(1, m), exponent) / m;
  return { x: x * shaped, y: y * shaped };
}

/** The unit view direction of a look. */
function lookDirection(look) {
  const c = Math.cos(look.pitch);
  return { x: Math.sin(look.yaw) * c, y: Math.sin(look.pitch), z: Math.cos(look.yaw) * c };
}

/**
 * Where the camera wants to be for a body at `pivot`'s feet and a look, before collision: `pivot` (the arm's root),
 * `shoulder` (the root moved to the right) and `eye`, plus the view direction. First person puts the eye in the head.
 */
function personCameraPose(feet, look, view, zoom = 1) {
  const dir = lookDirection(look);
  if (view === 'first') {
    const eye = { x: feet.x, y: feet.y + PERSON_CAMERA.eyeHeight, z: feet.z };
    return { pivot: eye, shoulder: eye, eye, dir, arm: 0, side: { x: 0, z: 0 } };
  }
  const pivot = { x: feet.x, y: feet.y + PERSON_CAMERA.pivotHeight, z: feet.z };
  const side = { x: -Math.cos(look.yaw), z: Math.sin(look.yaw) };
  const shoulder = { x: pivot.x + side.x * PERSON_CAMERA.shoulder, y: pivot.y, z: pivot.z + side.z * PERSON_CAMERA.shoulder };
  const arm = PERSON_CAMERA.distance * (Number.isFinite(zoom) && zoom > 0 ? zoom : 1);
  const eye = { x: shoulder.x - dir.x * arm, y: shoulder.y - dir.y * arm, z: shoulder.z - dir.z * arm };
  return { pivot, shoulder, eye, dir, arm, side };
}

// A collider's footprint as a polygon: its own, or the four corners of its (oriented) box, built once.
function footprintOf(c) {
  if (c.polygon) return c.polygon;
  if (c._armFootprint) return c._armFootprint;
  const o = c.obb;
  let ring;
  if (o) {
    // The collision code maps world to local with lx = dx cs - dz sn, lz = dx sn + dz cs; this is its inverse
    ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz]) => {
      const lx = sx * o.hx, lz = sz * o.hz;
      return { x: o.cx + lx * o.cs + lz * o.sn, z: o.cz - lx * o.sn + lz * o.cs };
    });
  } else {
    ring = [{ x: c.minX, z: c.minZ }, { x: c.maxX, z: c.minZ }, { x: c.maxX, z: c.maxZ }, { x: c.minX, z: c.maxZ }];
  }
  c._armFootprint = { outer: ring, holes: [] };
  return c._armFootprint;
}

function insideRing(ring, x, z) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a.z > z) !== (b.z > z) && x < (b.x - a.x) * (z - a.z) / (b.z - a.z) + a.x) inside = !inside;
  }
  return inside;
}

function insideFootprint(poly, x, z) {
  if (!insideRing(poly.outer, x, z)) return false;
  return !(poly.holes || []).some((hole) => insideRing(hole, x, z));
}

/**
 * How far along a ray (origin a, unit direction d) it first enters a collider - a footprint extruded from minY (0 when
 * unset) to maxY - within maxT; Infinity when it does not. A ray that starts inside one ignores it.
 */
function rayEntersCollider(c, ax, ay, az, dx, dy, dz, maxT) {
  const bottom = c.minY ?? 0, top = c.maxY;
  if (!Number.isFinite(top)) return Infinity;
  const poly = footprintOf(c);
  if (ay >= bottom && ay <= top && insideFootprint(poly, ax, az)) return Infinity;
  let best = Infinity;
  for (let r = -1; r < (poly.holes || []).length; r++) {
    const ring = r < 0 ? poly.outer : poly.holes[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const p = ring[j], q = ring[i], ex = q.x - p.x, ez = q.z - p.z;
      const cross = dx * ez - dz * ex;
      if (Math.abs(cross) < 1e-12) continue;
      const qx = p.x - ax, qz = p.z - az;
      const t = (qx * ez - qz * ex) / cross, u = (qx * dz - qz * dx) / cross;
      if (t <= 0 || t >= best || t > maxT || u < 0 || u > 1) continue;
      const y = ay + dy * t;
      if (y >= bottom && y <= top) best = t;
    }
  }
  // Down onto a low roof (a planter, a kiosk) when looking up from beside it
  if (dy < 0 && ay > top) {
    const t = (top - ay) / dy;
    if (t > 0 && t < best && t <= maxT && insideFootprint(poly, ax + dx * t, az + dz * t)) best = t;
  }
  return best;
}

/** The free length of a ray against a list of colliders, less the lens's probe radius, never below 0. */
function clearLength(colliders, from, to, probe = PERSON_CAMERA.probe) {
  const dx = to.x - from.x, dy = to.y - from.y, dz = to.z - from.z;
  const length = Math.hypot(dx, dy, dz);
  if (!(length > 1e-6)) return 0;
  const ux = dx / length, uy = dy / length, uz = dz / length;
  let hit = Infinity;
  for (const c of colliders || []) {
    const t = rayEntersCollider(c, from.x, from.y, from.z, ux, uy, uz, length + probe);
    if (t < hit) hit = t;
  }
  return hit === Infinity ? length : Math.max(0, Math.min(length, hit - probe));
}

/**
 * The spring arm: how long it may be behind the shoulder against the colliders in reach, given where it wants to be
 * (`pose` from personCameraPose). The shoulder offset is shortened first, so a wall at the right shoulder pulls the
 * camera in behind the head instead of through the wall. Returns { side, arm } in metres.
 */
function springArm(colliders, pose) {
  const reach = PERSON_CAMERA.shoulder;
  const sideTo = { x: pose.pivot.x + pose.side.x * reach, y: pose.pivot.y, z: pose.pivot.z + pose.side.z * reach };
  const side = reach > 0 ? clearLength(colliders, pose.pivot, sideTo) : 0;
  const shoulder = { x: pose.pivot.x + pose.side.x * side, y: pose.pivot.y, z: pose.pivot.z + pose.side.z * side };
  const back = { x: shoulder.x - pose.dir.x * pose.arm, y: shoulder.y - pose.dir.y * pose.arm, z: shoulder.z - pose.dir.z * pose.arm };
  const arm = Math.max(Math.min(PERSON_CAMERA.minArm, pose.arm), clearLength(colliders, shoulder, back));
  return { side, arm };
}

/** The arm's length this frame: in at once to clear a wall, back out gently once the wall is passed. */
function stepArm(current, allowed, dt, rate = PERSON_CAMERA.armReturnRate) {
  if (!Number.isFinite(current) || allowed <= current) return allowed;
  return current + (allowed - current) * (1 - Math.exp(-rate * (dt > 0 ? dt : 0)));
}

// The keyboard, by action. Ctrl descends as well as Q and C: it is where flight games put "down".
const KEY_BINDINGS = Object.freeze({
  forward: ['KeyW', 'ArrowUp'],
  backward: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  up: ['Space', 'KeyE'],
  down: ['KeyQ', 'KeyC', 'ControlLeft', 'ControlRight'],
  turbo: ['ShiftLeft', 'ShiftRight'] // the helicopter's only; Shift+V still steps the camera back
});

export {
  BODY_MOTION, KEY_BINDINGS, BRAKE_LAMP, HELI_CRUISE_SPEED, HELI_TURBO, LOOK_SENSITIVITY, PERSON_CAMERA, PERSON_MOVE, TURN_SIGNAL,
  approachVelocity, arrivalFor, bodyIsFinite, brakeLamp, cameraRelativeMove, clampSensitivity, clearLength,
  createJumpState, createTurnSignal, heliTopSpeed, hudReadout, lookCurve, lookDirection, personCameraPose,
  rayEntersCollider, settleBody, springArm, stepArm, stepJump, stepTurbo, stepTurnSignal, turnLamps, turnLook,
  turnToward, wrapAngle
};
