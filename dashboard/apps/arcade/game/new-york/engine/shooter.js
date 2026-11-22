import { t } from './i18n.js';
import * as THREE from 'three/webgpu';
import { falloff, lineOfSight, resolveShot } from './hit-resolution.js';
import { WEAPONS, addAmmo, createWeaponState, isReloading, pullTrigger, recoverRecoil, startReload } from './weapons.js';
import {
  AI, coolWanted, createCrewMember, createWanted, crewBudget, damageMember, raiseWanted, stars, think
} from './combat-ai.js';

// js/shooter.js
// The GTA-style shooter on top of the city: on foot (and from the driver's seat) the player aims with the right
// mouse button or the left trigger (the camera moves over the shoulder and narrows), fires with the left button or
// the right trigger, reloads with R and switches weapon with the wheel or G. Shots are hitscan from the crosshair
// (weapons.js), stop at the first building (hit-resolution.js) and hurt crews by body part. Crews patrol, hear and
// see, fight, take cover and search (combat-ai.js); the wanted level brings more of them. Gunshots are synthesized
// with WebAudio, so nothing is downloaded.
// No light is added to the scene (every lit material would recompile): muzzle flashes and impacts are emissive.

const ORDER = ['pistol', 'smg', 'rifle', 'shotgun'];
const EYE = 1.6;
const NEAR_RADIUS = 160;
const PLAYER_HEALTH = 100;
const SENSE_INTERVAL = 0.2;

const _forward = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();

function crewMaterial(color, emissive = 0x000000) {
  return new THREE.MeshStandardNodeMaterial({ color, roughness: 0.7, metalness: 0.05, emissive });
}

class Shooter {
  /**
   * @param {object} deps
   * @param {THREE.Scene} deps.scene
   * @param {object} deps.cameraSystem       cameras.js (camera, isPersonView())
   * @param {object} deps.controllerManager  controllers.js (getActiveEntity(), activeMode)
   * @param {object[]} deps.colliders        the city's axis-aligned colliders
   * @param {HTMLElement} deps.canvas
   * @param {{ value: number }} deps.damage  post-processing's damage uniform
   * @param {() => boolean} deps.soundOn     whether the game's sound is on
   */
  constructor({ scene, cameraSystem, controllerManager, colliders, canvas, damage, soundOn }) {
    this.scene = scene;
    this.cameraSystem = cameraSystem;
    this.controllerManager = controllerManager;
    this.colliders = colliders;
    this.near = [];
    this.nearRefreshAt = 0;
    this.damage = damage;
    this.soundOn = soundOn;
    this.root = new THREE.Group();
    this.root.name = 'Shooter';
    scene.add(this.root);

    this.inventory = { pistol: createWeaponState('pistol') };
    this.current = 'pistol';
    this.health = PLAYER_HEALTH;
    this.lastHurtAt = -Infinity;
    this.hurt = 0;
    this.deadUntil = 0;
    this.wanted = createWanted();
    this.crew = [];
    this.nextCrewId = 1;
    this.nextSpawnAt = 4;
    this.senseTimer = 0;
    this.heardShotAt = null;
    this.pickups = [];
    this.time = 0;
    this.input = { fire: false, aim: false, padFire: false, padAim: false };
    this.audio = null;

    this.materials = {
      jacket: crewMaterial(0x2a2f3a),
      skin: crewMaterial(0xb48a6a),
      legs: crewMaterial(0x1b1d22),
      gun: crewMaterial(0x111111),
      flash: new THREE.MeshBasicNodeMaterial({ color: 0xffd28a, transparent: true, depthWrite: false }),
      tracer: new THREE.MeshBasicNodeMaterial({ color: 0xfff0c0, transparent: true, opacity: 0.7, depthWrite: false }),
      spark: new THREE.MeshBasicNodeMaterial({ color: 0xffb060 }),
      pickup: crewMaterial(0x203040, 0x2aa8ff)
    };
    this.geometry = {
      body: new THREE.BoxGeometry(0.5, 0.72, 0.3),
      head: new THREE.SphereGeometry(0.13, 12, 8),
      legs: new THREE.BoxGeometry(0.4, 0.8, 0.24),
      gun: new THREE.BoxGeometry(0.08, 0.12, 0.45),
      flash: new THREE.SphereGeometry(0.12, 8, 6),
      tracer: new THREE.BoxGeometry(0.025, 0.025, 1),
      spark: new THREE.SphereGeometry(0.06, 6, 4),
      pickup: new THREE.BoxGeometry(0.6, 0.25, 0.25)
    };

    this.playerGun = new THREE.Mesh(this.geometry.gun, this.materials.gun);
    this.root.add(this.playerGun);
    this.flash = new THREE.Mesh(this.geometry.flash, this.materials.flash);
    this.flash.visible = false;
    this.root.add(this.flash);
    this.flashUntil = 0;
    this.tracers = Array.from({ length: 12 }, () => this.pooled(this.geometry.tracer, this.materials.tracer));
    this.sparks = Array.from({ length: 24 }, () => this.pooled(this.geometry.spark, this.materials.spark));
    this.tracerIndex = 0;
    this.sparkIndex = 0;

    this.buildHud();
    this.bindInput(canvas);
  }

  pooled(geometry, material) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.visible = false;
    mesh.userData.until = 0;
    this.root.add(mesh);
    return mesh;
  }

  // HUD

  buildHud() {
    const hud = document.createElement('div');
    hud.className = 'shooter-hud';
    hud.setAttribute('aria-live', 'polite');
    hud.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:5;font:600 14px/1.2 inherit;color:#fff;'
      + 'text-shadow:0 1px 2px rgba(0,0,0,.8)';
    hud.innerHTML = `
      <div data-x="cross" style="position:absolute;left:50%;top:50%;width:22px;height:22px;transform:translate(-50%,-50%)">
        <span style="position:absolute;left:10px;top:0;width:2px;height:7px;background:#fff"></span>
        <span style="position:absolute;left:10px;bottom:0;width:2px;height:7px;background:#fff"></span>
        <span style="position:absolute;top:10px;left:0;width:7px;height:2px;background:#fff"></span>
        <span style="position:absolute;top:10px;right:0;width:7px;height:2px;background:#fff"></span>
      </div>
      <div data-x="hit" style="position:absolute;left:50%;top:50%;width:30px;height:30px;transform:translate(-50%,-50%) rotate(45deg);border:2px solid #ff5a4a;opacity:0"></div>
      <div style="position:absolute;right:24px;top:84px;text-align:right;min-width:0;max-width:40vw">
        <div data-x="stars" style="font-size:22px;letter-spacing:2px;color:#ffd24a"></div>
        <div data-x="weapon" style="margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>
        <div data-x="ammo" style="font-size:26px;font-variant-numeric:tabular-nums"></div>
        <div style="margin-top:6px;width:160px;height:6px;background:rgba(255,255,255,.2);border-radius:3px;margin-left:auto">
          <div data-x="health" style="height:100%;background:#4ade80;border-radius:3px;transform-origin:left"></div>
        </div>
      </div>
      <div data-x="message" style="position:absolute;left:50%;top:38%;transform:translateX(-50%);font-size:40px;letter-spacing:1px;opacity:0;max-width:90vw;text-align:center"></div>
      <div data-x="hint" style="position:absolute;left:50%;bottom:150px;transform:translateX(-50%);font-size:13px;opacity:.85;max-width:90vw;text-align:center"></div>`;
    document.body.appendChild(hud);
    this.hud = Object.fromEntries([...hud.querySelectorAll('[data-x]')].map((el) => [el.dataset.x, el]));
    this.hudRoot = hud;
    this.hud.hint.textContent = t('shooter.hint');
    this.hintUntil = 12;
    this.messageUntil = 0;
  }

  say(text, seconds = 2) {
    this.hud.message.textContent = text;
    this.hud.message.style.opacity = '1';
    this.messageUntil = this.time + seconds;
  }

  renderHud(enabled) {
    this.hudRoot.style.display = enabled ? '' : 'none';
    if (!enabled) return;
    const state = this.inventory[this.current];
    const level = stars(this.wanted);
    this.hud.stars.textContent = '★'.repeat(level) + '☆'.repeat(5 - level);
    this.hud.stars.setAttribute('aria-label', t('shooter.wanted', { level }));
    this.hud.weapon.textContent = t(`shooter.weapons.${this.current}`);
    this.hud.ammo.textContent = isReloading(state, this.time) ? t('shooter.reloading') : `${state.magazine} / ${state.reserve}`;
    this.hud.health.style.transform = `scaleX(${Math.max(0, this.health) / PLAYER_HEALTH})`;
    this.hud.health.style.background = this.health < 35 ? '#ef4444' : '#4ade80';
    this.hud.cross.style.opacity = this.isAiming() ? '1' : '0.55';
    if (this.time > this.messageUntil) this.hud.message.style.opacity = '0';
    if (this.time > this.hintUntil) this.hud.hint.style.opacity = '0';
  }

  // Input

  bindInput(canvas) {
    // Mouse events, not pointer events: a second button pressed while one is held (fire while aiming) raises no
    // second pointerdown, only a mousedown
    canvas.addEventListener('mousedown', (e) => {
      if (e.button === 2) this.input.aim = true;
      if (e.button === 0 && (document.pointerLockElement === canvas || this.input.aim)) this.input.fire = true;
    });
    window.addEventListener('mouseup', (e) => {
      if (e.button === 2) this.input.aim = false;
      if (e.button === 0) this.input.fire = false;
    });
    window.addEventListener('blur', () => {
      this.input.fire = false;
      this.input.aim = false;
    });
    canvas.addEventListener('wheel', (e) => {
      if (this.enabled()) this.cycle(e.deltaY > 0 ? 1 : -1);
    }, { passive: true });
    window.addEventListener('keydown', (e) => {
      if (!this.enabled() || e.target instanceof HTMLInputElement || e.repeat) return;
      if (e.code === 'KeyR') startReload(this.inventory[this.current], this.time);
      else if (e.code === 'KeyG') this.cycle(1);
    });
  }

  readPad() {
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const pad = [...pads].find((p) => p && p.connected);
    // Triggers drive the car, so the pad fires on foot only
    const onFoot = this.controllerManager.activeMode === 'person';
    this.input.padAim = !!pad && onFoot && (pad.buttons[6]?.value ?? 0) > 0.4;
    this.input.padFire = !!pad && onFoot && (pad.buttons[7]?.value ?? 0) > 0.4;
  }

  cycle(step) {
    const owned = ORDER.filter((id) => this.inventory[id]);
    this.current = owned[(owned.indexOf(this.current) + step + owned.length) % owned.length];
  }

  enabled() {
    const mode = this.controllerManager.activeMode;
    return (mode === 'person' || mode === 'car') && this.cameraSystem.getActivePreset?.().category !== 'scenic';
  }

  isAiming() {
    return this.input.aim || this.input.padAim;
  }

  // Sound: a noise crack through a band-pass plus a falling low thump

  sound(kind, volume = 1) {
    if (!this.soundOn() || volume < 0.02) return;
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return;
    if (!this.audio) {
      const context = new Context();
      const length = Math.floor(context.sampleRate * 0.35);
      const noise = context.createBuffer(1, length, context.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 2;
      this.audio = { context, noise };
    }
    const { context, noise } = this.audio;
    if (context.state === 'suspended') context.resume().catch(() => {});
    const now = context.currentTime;
    const heavy = kind === 'shotgun' || kind === 'rifle';
    const out = context.createGain();
    out.gain.setValueAtTime(0.5 * volume, now);
    out.gain.exponentialRampToValueAtTime(0.001, now + (heavy ? 0.45 : 0.25));
    out.connect(context.destination);
    const crack = context.createBufferSource();
    crack.buffer = noise;
    const band = context.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = kind === 'pistol' ? 1800 : kind === 'smg' ? 2400 : 1200;
    band.Q.value = 0.7;
    crack.connect(band).connect(out);
    crack.start(now);
    const thump = context.createOscillator();
    thump.frequency.setValueAtTime(heavy ? 140 : 180, now);
    thump.frequency.exponentialRampToValueAtTime(40, now + 0.15);
    const thumpGain = context.createGain();
    thumpGain.gain.setValueAtTime(0.6 * volume, now);
    thumpGain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
    thump.connect(thumpGain).connect(context.destination);
    thump.start(now);
    thump.stop(now + 0.2);
  }

  // Effects

  tracer(from, to) {
    const mesh = this.tracers[this.tracerIndex++ % this.tracers.length];
    const length = from.distanceTo(to);
    mesh.position.copy(from).lerp(to, 0.5);
    mesh.scale.set(1, 1, length);
    mesh.lookAt(to);
    mesh.visible = true;
    mesh.userData.until = this.time + 0.05;
  }

  spark(point) {
    const mesh = this.sparks[this.sparkIndex++ % this.sparks.length];
    mesh.position.set(point.x, point.y, point.z);
    mesh.scale.setScalar(1);
    mesh.visible = true;
    mesh.userData.until = this.time + 0.25;
  }

  // Crew

  spawnCrew(player) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const angle = Math.random() * Math.PI * 2;
      const distance = 35 + Math.random() * 30;
      const x = player.x + Math.sin(angle) * distance;
      const z = player.z + Math.cos(angle) * distance;
      if (this.blocked(x, z)) continue;
      const member = createCrewMember(this.nextCrewId++, x, z);
      member.weapon = Math.random() < 0.3 ? 'smg' : 'pistol';
      member.group = new THREE.Group();
      const legs = new THREE.Mesh(this.geometry.legs, this.materials.legs);
      legs.position.y = 0.4;
      const body = new THREE.Mesh(this.geometry.body, this.materials.jacket);
      body.position.y = 1.16;
      const head = new THREE.Mesh(this.geometry.head, this.materials.skin);
      head.position.y = 1.66;
      const gun = new THREE.Mesh(this.geometry.gun, this.materials.gun);
      gun.position.set(0.22, 1.2, 0.3);
      member.group.add(legs, body, head, gun);
      member.group.position.set(x, player.y, z);
      member.y = player.y;
      this.root.add(member.group);
      this.crew.push(member);
      return;
    }
  }

  blocked(x, z) {
    for (const c of this.near) {
      if ((c.maxY ?? Infinity) > 1 && (c.minY ?? 0) < 1.5 && x > c.minX - 0.3 && x < c.maxX + 0.3 && z > c.minZ - 0.3 && z < c.maxZ + 0.3) return true;
    }
    return false;
  }

  hitTargets() {
    return this.crew.filter((m) => m.alive).map((m) => ({
      id: m.id, member: m, alive: true,
      parts: [
        { part: 'head', x: m.x, y: m.y + 1.66, z: m.z, radius: 0.17 },
        { part: 'body', x: m.x, y: m.y + 1.12, z: m.z, radius: 0.34 },
        { part: 'legs', x: m.x, y: m.y + 0.45, z: m.z, radius: 0.3 }
      ]
    }));
  }

  // The player's shots

  fire(camera, player) {
    const state = this.inventory[this.current];
    const moving = Math.abs(this.controllerManager.getActiveEntity().speed ?? 0) > 0.5;
    const shot = pullTrigger(state, this.time, {
      down: (this.input.fire || this.input.padFire) && this.deadUntil <= this.time,
      aiming: this.isAiming(),
      moving
    });
    if (!shot || shot.empty) return;
    const weapon = state.weapon;
    camera.getWorldDirection(_forward);
    _right.crossVectors(_forward, camera.up).normalize();
    _up.crossVectors(_right, _forward).normalize();
    // The ray leaves from the crosshair, starting level with the player so nothing behind them is hit
    const toPlayer = new THREE.Vector3(player.x - camera.position.x, player.y + EYE - camera.position.y, player.z - camera.position.z);
    const start = camera.position.clone().addScaledVector(_forward, Math.max(0, toPlayer.dot(_forward)));
    const muzzle = this.playerGun.position.clone().addScaledVector(_forward, 0.3);
    const targets = this.hitTargets();
    let hitSomeone = false;
    for (const pellet of shot.pellets) {
      _dir.copy(_forward).addScaledVector(_right, pellet.yaw).addScaledVector(_up, pellet.pitch).normalize();
      const hit = resolveShot(start, _dir, weapon.range, this.near, targets);
      const end = new THREE.Vector3(hit.point.x, hit.point.y, hit.point.z);
      this.tracer(muzzle, end);
      if (hit.kind !== 'none') this.spark(hit.point);
      if (hit.kind === 'target') {
        hitSomeone = true;
        const member = hit.target.member;
        const amount = weapon.damage * hit.multiplier * falloff(hit.distance, weapon.range);
        member.lastSeen = { x: player.x, z: player.z };
        if (member.state !== 'engage') member.state = 'engage';
        if (damageMember(member, amount)) this.takedown(member);
        else raiseWanted(this.wanted, 'hit');
      }
    }
    if (hitSomeone) {
      this.hud.hit.style.opacity = '1';
      this.hitMarkUntil = this.time + 0.12;
    }
    this.flash.position.copy(muzzle);
    this.flash.visible = true;
    this.flashUntil = this.time + 0.05;
    this.heardShotAt = { x: player.x, z: player.z };
    if (this.crew.some((m) => m.alive && Math.hypot(m.x - player.x, m.z - player.z) < AI.hearing)) raiseWanted(this.wanted, 'shot');
    this.sound(weapon.id, 1);
  }

  takedown(member) {
    raiseWanted(this.wanted, 'takedown');
    member.group.rotation.z = Math.PI / 2;
    member.group.position.y = member.y + 0.25;
    member.removeAt = this.time + 8;
    // What they carried is left where they fell
    this.dropPickup(member.x + 0.6, member.z, member.weapon, member.y);
  }

  dropPickup(x, z, weapon, y) {
    const mesh = new THREE.Mesh(this.geometry.pickup, this.materials.pickup);
    mesh.position.set(x, y + 0.4, z);
    this.root.add(mesh);
    this.pickups.push({ x, z, weapon, mesh });
  }

  collectPickups(player) {
    for (let i = this.pickups.length - 1; i >= 0; i--) {
      const p = this.pickups[i];
      p.mesh.rotation.y += 0.04;
      if (Math.hypot(p.x - player.x, p.z - player.z) > 1.6 || this.controllerManager.activeMode !== 'person') continue;
      if (this.inventory[p.weapon]) addAmmo(this.inventory[p.weapon], WEAPONS[p.weapon].magazine * 2);
      else this.inventory[p.weapon] = createWeaponState(p.weapon);
      this.say(t('shooter.picked', { weapon: t(`shooter.weapons.${p.weapon}`) }), 1.6);
      this.root.remove(p.mesh);
      this.pickups.splice(i, 1);
    }
  }

  // The crews' turn

  updateCrew(dt, player, inCar) {
    this.senseTimer += dt;
    const sense = this.senseTimer >= SENSE_INTERVAL;
    if (sense) this.senseTimer = 0;
    const eye = { x: player.x, y: player.y + EYE, z: player.z };
    let engaged = false;
    for (const m of this.crew) {
      if (!m.alive) continue;
      const dx = player.x - m.x, dz = player.z - m.z;
      const distance = Math.hypot(dx, dz);
      if (sense) {
        m.sees = distance < AI.sight && lineOfSight({ x: m.x, y: m.y + EYE, z: m.z }, eye, this.near);
        const heard = this.heardShotAt && Math.hypot(this.heardShotAt.x - m.x, this.heardShotAt.z - m.z) < AI.hearing;
        think(m, { seesPlayer: m.sees, player, heardShotAt: heard ? this.heardShotAt : null }, SENSE_INTERVAL);
      }
      if (m.state === 'engage') engaged = true;
      // Moving: towards the target, keeping 12-25 m in a fight, away from the player in cover
      let goal = m.target;
      let speed = m.state === 'patrol' ? 1.4 : 3.6;
      if (m.state === 'patrol') {
        if (!m.patrol || Math.hypot(m.patrol.x - m.x, m.patrol.z - m.z) < 1) {
          m.patrol = { x: m.home.x + (Math.random() - 0.5) * 30, z: m.home.z + (Math.random() - 0.5) * 30 };
        }
        goal = m.patrol;
      } else if (m.state === 'engage' && distance < 14) {
        goal = null;
      } else if (m.state === 'cover') {
        goal = { x: m.x - dx, z: m.z - dz };
        speed = 4.2;
      }
      if (goal) {
        const gx = goal.x - m.x, gz = goal.z - m.z;
        const gl = Math.hypot(gx, gz);
        if (gl > 0.5) {
          const nx = m.x + (gx / gl) * speed * dt, nz = m.z + (gz / gl) * speed * dt;
          if (!this.blocked(nx, nz)) {
            m.x = nx;
            m.z = nz;
          } else if (m.state === 'patrol') {
            m.patrol = null;
          }
          m.heading = Math.atan2(gx, gz);
        }
      }
      if (m.state === 'engage' || m.state === 'cover') m.heading = Math.atan2(dx, dz);
      m.group.position.set(m.x, m.y, m.z);
      m.group.rotation.y = m.heading;
      // Their fire: worse with distance, worse at a moving car
      if (m.state === 'engage' && m.sees && this.time >= m.nextShotAt && this.deadUntil <= this.time) {
        const weapon = WEAPONS[m.weapon];
        m.nextShotAt = this.time + (1 / weapon.rate) * (2.2 + Math.random() * 1.5);
        const chance = Math.min(0.5, Math.max(0.08, 0.55 - distance / 110)) * (inCar ? 0.55 : 1);
        const from = new THREE.Vector3(m.x, m.y + 1.25, m.z);
        const hit = Math.random() < chance;
        const to = new THREE.Vector3(player.x + (hit ? 0 : (Math.random() - 0.5) * 3), player.y + 1.2, player.z + (hit ? 0 : (Math.random() - 0.5) * 3));
        this.tracer(from, to);
        this.sound(weapon.id, Math.max(0, 1 - distance / 90) * 0.7);
        if (hit) this.hurtPlayer(weapon.damage * 0.22 * (inCar ? 0.6 : 1));
      }
    }
    // Bodies are cleared after a while; crew too far behind are dropped
    for (let i = this.crew.length - 1; i >= 0; i--) {
      const m = this.crew[i];
      const far = Math.hypot(m.x - player.x, m.z - player.z) > NEAR_RADIUS;
      if ((!m.alive && this.time > m.removeAt) || far) {
        this.root.remove(m.group);
        this.crew.splice(i, 1);
      }
    }
    coolWanted(this.wanted, dt, engaged);
    this.heardShotAt = null;
  }

  hurtPlayer(amount) {
    this.health -= amount;
    this.lastHurtAt = this.time;
    this.hurt = Math.min(1, this.hurt + amount / 30);
    if (this.health > 0) return;
    this.health = 0;
    this.deadUntil = this.time + 3.5;
    this.say(t('shooter.wasted'), 3.5);
  }

  respawn() {
    this.health = PLAYER_HEALTH;
    this.wanted = createWanted();
    for (const m of this.crew) this.root.remove(m.group);
    this.crew = [];
    this.nextSpawnAt = this.time + 8;
  }

  /** Once a frame while the city runs, after the camera has moved. */
  update(dt) {
    this.time += dt;
    const on = this.enabled();
    this.readPad();
    const entity = this.controllerManager.getActiveEntity();
    const camera = this.cameraSystem.camera;
    const player = { x: entity.position.x, y: this.controllerManager.activeMode === 'person' ? entity.position.y : 0, z: entity.position.z };
    if (this.time > this.nearRefreshAt) {
      this.nearRefreshAt = this.time + 1;
      this.near = this.colliders.filter((c) => c.maxX > player.x - NEAR_RADIUS && c.minX < player.x + NEAR_RADIUS
        && c.maxZ > player.z - NEAR_RADIUS && c.minZ < player.z + NEAR_RADIUS);
      if (this.pickups.length === 0 && on) {
        for (const id of ['smg', 'rifle', 'shotgun']) {
          const a = Math.random() * Math.PI * 2, d = 12 + Math.random() * 25;
          const x = player.x + Math.sin(a) * d, z = player.z + Math.cos(a) * d;
          if (!this.blocked(x, z)) this.dropPickup(x, z, id, player.y);
        }
      }
    }

    if (this.deadUntil && this.time > this.deadUntil) {
      this.deadUntil = 0;
      this.respawn();
    }
    if (this.time - this.lastHurtAt > 5 && this.health > 0) this.health = Math.min(PLAYER_HEALTH, this.health + 8 * dt);
    this.hurt = Math.max(0, this.hurt - dt * 0.8);
    this.damage.value = Math.max(this.hurt, this.health < 35 ? (35 - this.health) / 70 : 0);

    // Over the shoulder and narrower while aiming on foot; recoil kicks the view and eases back
    const state = this.inventory[this.current];
    const back = recoverRecoil(state, dt);
    if (on) {
      if (this.isAiming() && this.controllerManager.activeMode === 'person' && this.cameraSystem.isPersonView?.()) {
        camera.translateX(0.6);
        camera.translateZ(-1.4);
        camera.fov *= state.weapon.aimFov;
        camera.updateProjectionMatrix();
      }
      camera.rotateX(state.recoilPitch);
      camera.rotateY(-state.recoilYaw);
      camera.updateMatrixWorld();
    }
    void back;

    // The player's gun, in the right hand
    const heading = entity.heading ?? 0;
    this.playerGun.visible = on && this.controllerManager.activeMode === 'person';
    this.playerGun.position.set(
      player.x + Math.cos(heading) * -0.28 + Math.sin(heading) * 0.35,
      player.y + 1.2,
      player.z - Math.sin(heading) * -0.28 + Math.cos(heading) * 0.35
    );
    this.playerGun.rotation.set(0, heading, 0);

    if (on) {
      this.fire(camera, player);
      this.collectPickups(player);
      if (this.time > this.nextSpawnAt) {
        this.nextSpawnAt = this.time + 3;
        if (this.crew.filter((m) => m.alive).length < crewBudget(stars(this.wanted))) this.spawnCrew(player);
      }
    }
    this.updateCrew(dt, player, this.controllerManager.activeMode === 'car');

    if (this.time > this.flashUntil) this.flash.visible = false;
    if (this.hitMarkUntil && this.time > this.hitMarkUntil) this.hud.hit.style.opacity = '0';
    for (const mesh of [...this.tracers, ...this.sparks]) {
      if (!mesh.visible) continue;
      if (this.time > mesh.userData.until) mesh.visible = false;
      else if (mesh.geometry === this.geometry.spark) mesh.scale.multiplyScalar(0.85);
    }
    this.root.updateMatrixWorld(true);
    this.renderHud(on);
  }
}

export { Shooter };
