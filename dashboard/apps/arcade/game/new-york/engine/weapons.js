// js/weapons.js
// Hitscan weapons as plain data and pure functions, so the rules can be tested without a renderer.
//   magazine / reserve  rounds in the gun and carried; a reload moves the difference over after `reload` seconds
//   rate                rounds per second (automatic weapons fire while the trigger is held)
//   spread              cone half-angle in radians from the hip; aiming multiplies it by `aimSpread`, moving by
//                       `moveSpread`, and every shot adds `bloom` that recovers at `bloomRecovery` per second
//   recoil              camera kick per shot (pitch up, a random yaw), recovered at `recovery` per second
//   damage              per pellet at the body; `pellets` > 1 for the shotgun; `range` in metres

const WEAPONS = {
  pistol: {
    id: 'pistol', magazine: 12, reserve: 60, rate: 4, automatic: false, reload: 1.3, damage: 34, pellets: 1, range: 120,
    spread: 0.012, aimSpread: 0.35, moveSpread: 1.8, bloom: 0.01, bloomRecovery: 0.08, recoil: 0.022, recovery: 0.16,
    aimFov: 0.8
  },
  smg: {
    id: 'smg', magazine: 30, reserve: 150, rate: 12, automatic: true, reload: 1.8, damage: 21, pellets: 1, range: 90,
    spread: 0.03, aimSpread: 0.5, moveSpread: 1.5, bloom: 0.006, bloomRecovery: 0.12, recoil: 0.012, recovery: 0.22,
    aimFov: 0.78
  },
  rifle: {
    id: 'rifle', magazine: 30, reserve: 120, rate: 9, automatic: true, reload: 2.2, damage: 30, pellets: 1, range: 200,
    spread: 0.022, aimSpread: 0.25, moveSpread: 2, bloom: 0.006, bloomRecovery: 0.1, recoil: 0.018, recovery: 0.2,
    aimFov: 0.62
  },
  shotgun: {
    id: 'shotgun', magazine: 6, reserve: 30, rate: 1.2, automatic: false, reload: 2.6, damage: 14, pellets: 9, range: 45,
    spread: 0.075, aimSpread: 0.7, moveSpread: 1.3, bloom: 0, bloomRecovery: 0.1, recoil: 0.06, recovery: 0.14,
    aimFov: 0.85
  }
};

function createWeaponState(id, { magazine, reserve } = {}) {
  const weapon = WEAPONS[id];
  if (!weapon) throw new Error(`unknown weapon ${id}`);
  return {
    weapon,
    magazine: magazine ?? weapon.magazine,
    reserve: reserve ?? weapon.reserve,
    nextShotAt: 0,
    reloadingUntil: 0,
    bloom: 0,
    recoilPitch: 0,
    recoilYaw: 0,
    triggerWasDown: false
  };
}

/** The cone half-angle a shot leaves within right now. */
function currentSpread(state, { aiming = false, moving = false } = {}) {
  const w = state.weapon;
  return (w.spread + state.bloom) * (aiming ? w.aimSpread : 1) * (moving ? w.moveSpread : 1);
}

function isReloading(state, now) {
  return state.reloadingUntil !== 0 && now < state.reloadingUntil;
}

/** Starts a reload when it would do anything; true if it started. */
function startReload(state, now) {
  const w = state.weapon;
  if (isReloading(state, now) || state.magazine >= w.magazine || state.reserve <= 0) return false;
  state.reloadingUntil = now + w.reload;
  return true;
}

/** Moves rounds from the reserve once a reload's time is up. */
function finishReload(state, now) {
  if (state.reloadingUntil === 0 || now < state.reloadingUntil) return false;
  const moved = Math.min(state.weapon.magazine - state.magazine, state.reserve);
  state.magazine += moved;
  state.reserve -= moved;
  state.reloadingUntil = 0;
  return true;
}

/**
 * The trigger, read once a frame. Returns null when no round leaves, else the shot: one direction offset per pellet
 * (yaw and pitch in radians, uniform over the cone's disc) and the recoil it adds. An empty magazine starts a reload.
 */
function pullTrigger(state, now, { down, aiming = false, moving = false, random = Math.random } = {}) {
  const w = state.weapon;
  const pressed = down && !state.triggerWasDown;
  state.triggerWasDown = !!down;
  finishReload(state, now);
  if (!down || (!w.automatic && !pressed)) return null;
  if (isReloading(state, now) || now < state.nextShotAt) return null;
  if (state.magazine <= 0) {
    startReload(state, now);
    return { empty: true, pellets: [] };
  }
  const spread = currentSpread(state, { aiming, moving });
  const pellets = [];
  for (let i = 0; i < w.pellets; i++) {
    // Uniform over the disc: the radius from a square root, so the centre is not oversampled
    const r = spread * Math.sqrt(random());
    const a = random() * Math.PI * 2;
    pellets.push({ yaw: Math.cos(a) * r, pitch: Math.sin(a) * r });
  }
  state.magazine -= 1;
  state.nextShotAt = now + 1 / w.rate;
  state.bloom = Math.min(state.bloom + w.bloom, w.spread * 3);
  const kickYaw = (random() - 0.5) * w.recoil * 0.6;
  state.recoilPitch += w.recoil;
  state.recoilYaw += kickYaw;
  if (state.magazine === 0) startReload(state, now + 1 / w.rate);
  return { empty: false, pellets, recoil: { pitch: w.recoil, yaw: kickYaw } };
}

/** Recoil and bloom ease back each frame; returns the camera correction (radians) to apply this frame. */
function recoverRecoil(state, dt) {
  const w = state.weapon;
  const step = w.recovery * dt;
  const back = {
    pitch: Math.sign(state.recoilPitch) * Math.min(Math.abs(state.recoilPitch), step),
    yaw: Math.sign(state.recoilYaw) * Math.min(Math.abs(state.recoilYaw), step)
  };
  state.recoilPitch -= back.pitch;
  state.recoilYaw -= back.yaw;
  state.bloom = Math.max(0, state.bloom - w.bloomRecovery * dt);
  return back;
}

/** Ammo picked up for a weapon already carried, capped at three magazines over its starting reserve. */
function addAmmo(state, rounds) {
  state.reserve = Math.min(state.reserve + rounds, state.weapon.reserve + state.weapon.magazine * 3);
}

export {
  WEAPONS, addAmmo, createWeaponState, currentSpread, finishReload, isReloading, pullTrigger, recoverRecoil, startReload
};
