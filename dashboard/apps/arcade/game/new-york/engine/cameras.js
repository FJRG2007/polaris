import * as THREE from 'three/webgpu';
import { bryantParkLawn } from './landmarks.js';
import {
  PERSON_CAMERA, clampSensitivity, lookCurve, personCameraPose, springArm, stepArm, turnLook, wrapAngle
} from './player-rules.js';

const DEFAULT_NEAR = 0.35;
const SENSITIVITY_KEY = 'nyc-look-sensitivity';

// Chase, action, cockpit, fixed-location and aerial cameras, with mouse/touch orbit and zoom.

const CAMERA_PRESETS = [
  { id: 'chase',       category: 'follow', fov: 56 },
  { id: 'action',      category: 'follow', fov: 60 },
  { id: 'pov',         category: 'follow', fov: 68 },
  { id: 'centralPark', category: 'scenic', fov: 52 },
  { id: 'fifthAve',    category: 'scenic', fov: 48 },
  { id: 'timesSquare', category: 'scenic', fov: 58 },
  { id: 'chryslerGCT', category: 'scenic', fov: 50 },
  { id: 'observatory', category: 'scenic', fov: 52 },
  { id: 'bryantPark',  category: 'scenic', fov: 52 },
  { id: 'waterfront',  category: 'scenic', fov: 46 },
  { id: 'drone',       category: 'scenic', fov: 50 }
];

class CameraSystem {
  constructor(domElement, controllerManager) {
    this.domElement = domElement;
    this.controllerManager = controllerManager;

    this.camera = new THREE.PerspectiveCamera(
      56,
      window.innerWidth / window.innerHeight,
      DEFAULT_NEAR,
      60000 // at 1:1 the boroughs & harbor run out ~20-40 km to the fogged horizon (reversed float depth keeps precision)
    );

    this.activePresetId = 'chase';
    this.orbitYawOffset = 0.0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1.0;
    this.isDragging = false;
    this.userOrbitTimer = 0;

    this.currentPos = new THREE.Vector3(0, 10, 380);
    this.currentLookAt = new THREE.Vector3(0, 8, 440);
    this.initialized = false;

    // Follow cameras (chase / action) are smoothed relative to the followed entity, see update()
    this.followEntity = null;
    this.followOffset = new THREE.Vector3();
    this.followLookOffset = new THREE.Vector3();
    this.followBaseY = 0;
    this.smoothedSpeed = 0;
    this._desiredPos = new THREE.Vector3();
    this._desiredLook = new THREE.Vector3();

    // On foot the chase and first-person cameras share one look, held in world space rather than as an offset from the
    // body, so the stick and WASD move relative to it and switching between the two keeps the view (player-rules.js)
    this.personLook = { yaw: 0, pitch: PERSON_CAMERA.pitch };
    this.lookIdle = 0;
    this._personEntity = null;
    this._personReset = true;
    this._personPivot = new THREE.Vector3();
    this._personArm = NaN;
    this._personSide = NaN;
    this.lookSensitivity = 1;
    try { this.lookSensitivity = clampSensitivity(localStorage.getItem(SENSITIVITY_KEY)); } catch { /* Storage is optional. */ }
    /** Set by main.js: whether the mouse may be captured now (no menu, map or start screen over the city). */
    this.lockAllowed = () => true;

    this.bindPointerControls();
  }

  bindPointerControls() {
    const canvas = this.domElement;
    const pointers = new Map();
    canvas.style.touchAction = 'none';

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || pointers.size >= 2) return;
      // Only two touch pointers may share a gesture; mouse and pen drags stay independent.
      if (pointers.size && (e.pointerType !== 'touch' || pointers.values().next().value.type !== 'touch')) return;
      e.preventDefault();
      // On foot a click captures the mouse for look, as in a shooter; Esc gives it back (the browser's own rule)
      if (e.pointerType === 'mouse' && document.pointerLockElement !== canvas && this.canLockPointer()) {
        try { canvas.requestPointerLock?.()?.catch?.(() => {}); } catch { /* A frame without the permission drags instead. */ }
      }
      pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });
      canvas.setPointerCapture(e.pointerId);
      this.isDragging = true;
      this.userOrbitTimer = 4.0;
    });

    canvas.addEventListener('pointermove', (e) => {
      const pointer = pointers.get(e.pointerId);
      if (!pointer) return;
      e.preventDefault();
      const dx = e.clientX - pointer.x;
      const dy = e.clientY - pointer.y;
      const pair = pointers.size === 2 ? [...pointers.values()] : null;
      const previousDistance = pair ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
      pointer.x = e.clientX;
      pointer.y = e.clientY;

      if (!pair && this.isPersonView()) {
        // Under pointer lock the mousemove below already turns the view
        if (document.pointerLockElement !== canvas) {
          const k = PERSON_CAMERA.drag * this.lookSensitivity;
          this.lookBy(-dx * k, -dy * k);
        }
      } else if (pair) {
        const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
        if (previousDistance > 1 && distance > 1) {
          this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier * previousDistance / distance));
        }
      } else {
        this.orbitYawOffset -= dx * 0.0065;
        this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + dy * 0.005));
      }
      this.userOrbitTimer = 4.0;
    });

    const releasePointer = (id) => {
      if (!pointers.delete(id)) return;
      this.isDragging = pointers.size > 0;
      if (canvas.hasPointerCapture(id)) canvas.releasePointerCapture(id);
    };
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      canvas.addEventListener(type, (e) => releasePointer(e.pointerId));
    }
    const clearPointers = () => {
      for (const id of pointers.keys()) releasePointer(id);
    };
    this._clearPointers = clearPointers;
    window.addEventListener('blur', clearPointers);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) clearPointers();
    });

    document.addEventListener('mousemove', (e) => {
      if (document.pointerLockElement !== canvas || !this.isPersonView()) return;
      // Some browsers report one large jump as the lock starts
      const mx = Math.max(-300, Math.min(300, e.movementX || 0));
      const my = Math.max(-300, Math.min(300, e.movementY || 0));
      const k = PERSON_CAMERA.mouse * this.lookSensitivity;
      this.lookBy(-mx * k, -my * k);
    });

    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + e.deltaY * 0.001));
    }, { passive: false });
  }

  setCameraPreset(presetId, snapImmediately = false) {
    const preset = CAMERA_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    this.activePresetId = preset.id;
    this.camera.fov = preset.fov;
    this.camera.updateProjectionMatrix();
    if (snapImmediately) {
      this.initialized = false;
    }
  }

  /** Whether the on-foot look is in charge: the body is a person and the camera is the chase or first-person one. */
  isPersonView() {
    return this.controllerManager.getActiveEntity()?.type === 'person' &&
      (this.activePresetId === 'chase' || this.activePresetId === 'pov');
  }

  canLockPointer() {
    return this.isPersonView() && this.lockAllowed() !== false;
  }

  /** Turns the on-foot look, in radians (positive yaw left, positive pitch up). */
  lookBy(dYaw, dPitch) {
    turnLook(this.personLook, dYaw, dPitch, this.activePresetId === 'pov' ? 'first' : 'third');
    this.lookIdle = 0;
  }

  setLookSensitivity(value) {
    this.lookSensitivity = clampSensitivity(value);
    try { localStorage.setItem(SENSITIVITY_KEY, String(this.lookSensitivity)); } catch { /* Storage is optional. */ }
  }

  applyGamepadInput(lookX, lookY, zoom, dt) {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (this.activePresetId !== 'chase' && this.activePresetId !== 'pov') return;
    // POV uses the orbit angles, but only chase renders a zoomed camera distance.
    if (this.activePresetId !== 'chase') zoom = 0;
    if (!lookX && !lookY && !zoom) return;
    if (this.isPersonView()) {
      // The pad's radial deadzone is already off (gamepad-controls.js); the curve leaves small tilts for fine aim
      const c = lookCurve(lookX, lookY);
      const s = this.lookSensitivity;
      if (c.x || c.y) this.lookBy(-c.x * PERSON_CAMERA.pad.yaw * s * dt, -c.y * PERSON_CAMERA.pad.pitch * s * dt);
      this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
      return;
    }
    this.orbitYawOffset -= lookX * 2.0 * dt;
    this.orbitPitchOffset = Math.max(-0.32, Math.min(0.68, this.orbitPitchOffset + lookY * 1.25 * dt));
    this.zoomMultiplier = Math.max(0.45, Math.min(2.4, this.zoomMultiplier + zoom * 0.9 * dt));
    this.userOrbitTimer = 4.0;
  }

  resetOrbit() {
    this.orbitYawOffset = 0;
    this.orbitPitchOffset = 0.09;
    this.zoomMultiplier = 1;
    this.userOrbitTimer = 0;
    const entity = this.controllerManager.getActiveEntity();
    if (entity?.type === 'person') {
      this.personLook.yaw = wrapAngle(entity.heading);
      this.personLook.pitch = PERSON_CAMERA.pitch;
    }
  }

  resetForTeleport() {
    // Arrive with a fresh chase view, without carrying a previous drive or gesture into the destination.
    this._clearPointers();
    this.isDragging = false;
    this.resetOrbit();
    this.smoothedSpeed = 0;
    this.followEntity = null;
    this.followOffset.set(0, 0, 0);
    this.followLookOffset.set(0, 0, 0);
    this.followBaseY = 0;
    this._personReset = true;
    this.setCameraPreset('chase', true);
  }

  getActivePreset() {
    return CAMERA_PRESETS.find((p) => p.id === this.activePresetId) || CAMERA_PRESETS[0];
  }

  onResize(width, height) {
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  update(dt, elapsed) {
    const entity = this.controllerManager.getActiveEntity();
    const desiredPos = this._desiredPos;
    const desiredLook = this._desiredLook;

    if (this.userOrbitTimer > 0 && !this.isDragging) {
      this.userOrbitTimer = Math.max(0, this.userOrbitTimer - dt);
    }

    if (!this.isDragging && this.userOrbitTimer <= 0 && Math.abs(entity.speed) > 0.5) {
      this.orbitYawOffset -= Math.round(this.orbitYawOffset / (Math.PI * 2)) * (Math.PI * 2);
      this.orbitYawOffset += (0.0 - this.orbitYawOffset) * (1 - Math.exp(-dt * 2.2));
    }

    // The follow cameras pull back with speed, eased so that they drift back as the entity speeds up (and in as it
    // slows down); speedLag is about how far their former world-space smoothing left them trailing at 60 FPS
    this.smoothedSpeed += (Math.abs(entity.speed) - this.smoothedSpeed) * (1 - Math.exp(-dt * 3.0));
    const speedLag = this.smoothedSpeed * 0.1;

    const totalYaw = entity.heading + this.orbitYawOffset;
    const personView = this.isPersonView();
    if (!personView) {
      this.controllerManager.personHidden = false;
      this.controllerManager.personView = 'third';
      // Back on foot from a vehicle the look starts again behind the body; through the action camera (V between chase
      // and first person) it is kept
      if (entity?.type !== 'person') this._personEntity = null;
    }

    if (personView) this.updatePersonView(entity, dt);
    else switch (this.activePresetId) {
      case 'chase': {
        const dist = entity.chaseDistance * this.zoomMultiplier * (1 + Math.min(0.25, this.smoothedSpeed * 0.01));
        const height = entity.chaseHeight * this.zoomMultiplier + Math.sin(this.orbitPitchOffset) * dist * 0.85;
        const horizDist = Math.cos(this.orbitPitchOffset) * dist + speedLag;

        desiredPos.set(
          entity.position.x - Math.sin(totalYaw) * horizDist,
          Math.max(0.65, entity.position.y + height),
          entity.position.z - Math.cos(totalYaw) * horizDist
        );

        const lookUpBias = entity.type === 'helicopter' ? 0.2 : (entity.type === 'car' ? 0.52 : 1.55);
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 5.2,
          entity.position.y + entity.cameraTargetOffset.y + lookUpBias,
          entity.position.z + Math.cos(entity.heading) * 5.2
        );
        break;
      }

      case 'action': {
        const sideOffset = entity.type === 'car' ? 2.65 : (entity.type === 'helicopter' ? 4.2 : 0.95);
        const backDist = (entity.type === 'car' ? 3.6 : (entity.type === 'helicopter' ? 8.5 : 2.8)) + speedLag;
        const lowY = entity.type === 'helicopter' ? entity.position.y + 1.2 : entity.position.y + 0.92;

        desiredPos.set(
          entity.position.x - Math.sin(entity.heading) * backDist + Math.cos(entity.heading) * sideOffset,
          Math.max(0.55, lowY),
          entity.position.z - Math.cos(entity.heading) * backDist - Math.sin(entity.heading) * sideOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(entity.heading) * 3.2,
          entity.position.y + 1.05,
          entity.position.z + Math.cos(entity.heading) * 3.2
        );
        break;
      }

      case 'pov': {
        let fwdOffset = 0.35;
        let eyeY = 1.68;
        if (entity.type === 'car') {
          fwdOffset = 0.55;
          eyeY = 1.52;
        } else if (entity.type === 'cyclist') {
          fwdOffset = 0.35;
          eyeY = 1.55;
        } else if (entity.type === 'helicopter') {
          fwdOffset = 1.65;
          eyeY = 1.65;
        }

        desiredPos.set(
          entity.position.x + Math.sin(entity.heading) * fwdOffset,
          entity.position.y + eyeY,
          entity.position.z + Math.cos(entity.heading) * fwdOffset
        );
        desiredLook.set(
          entity.position.x + Math.sin(totalYaw) * 40.0,
          entity.position.y + eyeY + Math.sin(-this.orbitPitchOffset) * 18.0 + 1.5,
          entity.position.z + Math.cos(totalYaw) * 40.0
        );
        break;
      }

      case 'centralPark': {
        // Above the southern canopy, looking across The Pond toward the park and skyline.
        const sway = Math.sin(elapsed * 0.22) * 3.5;
        desiredPos.set(-70.0 + sway, 26.0, -1425.0);
        desiredLook.set(-250.0, 6.5, -1690.0);
        break;
      }

      case 'fifthAve': {
        // 5th Avenue & 42nd St looking South down the 5th Ave canyon toward the Empire State Building
        const sway = Math.sin(elapsed * 0.25) * 1.8;
        desiredPos.set(0.0 + sway, 6.5, -20.0);
        desiredLook.set(-60.0, 150.0, 686.0);
        break;
      }

      case 'timesSquare': {
        // Times Square & Broadway looking across Duffy Square red steps and One Times Square billboards
        const sway = Math.sin(elapsed * 0.3) * 3.0;
        desiredPos.set(-603.0 + sway, 5.5, -290.0);
        desiredLook.set(-566.0, 40.0, -40.0);
        break;
      }

      case 'chryslerGCT': {
        // Park Ave & 42nd St intersection looking straight at Grand Central, MetLife, and Chrysler Building Crown
        const sway = Math.cos(elapsed * 0.22) * 2.5;
        desiredPos.set(300.0 + sway, 9.5, 95.0);
        desiredLook.set(470.0, 120.0, -50.0);
        break;
      }

      case 'observatory': {
        // Empire State Building 86th Floor Deck looking North-East across Midtown skyline
        const pan = Math.sin(elapsed * 0.18) * 80.0;
        desiredPos.set(-58.0, 322.0, 660.0);
        desiredLook.set(420.0 + pan, 150.0, -200.0);
        break;
      }

      case 'bryantPark': {
        // Inside Bryant Park Great Lawn looking East toward NYPL portico, One Vanderbilt & Chrysler Building
        const sway = Math.sin(elapsed * 0.25) * 1.5;
        const lawn = bryantParkLawn || { minX: -260, maxX: -150, minZ: 40, maxZ: 120, top: 1.3 };
        const lz = (lawn.minZ + lawn.maxZ) * 0.5;
        desiredPos.set(lawn.minX + 18.0, lawn.top + 1.7, lz + sway);
        desiredLook.set(lawn.maxX + 260.0, 70.0, lz - 60.0);
        break;
      }

      case 'waterfront': {
        // Over the shimmering East River looking across the FDR Drive, Queensboro Bridge & Midtown Skyline
        const drift = Math.sin(elapsed * 0.15) * 40.0;
        desiredPos.set(1640.0, 60.0, 60.0 + drift);
        desiredLook.set(150.0, 150.0, -150.0);
        break;
      }

      case 'drone': {
        const angle = elapsed * 0.07 + 0.65;
        const radius = 720.0 + Math.sin(elapsed * 0.23) * 140.0;
        const alt = 330.0 + Math.cos(elapsed * 0.19) * 90.0;
        desiredPos.set(
          Math.cos(angle) * radius + 60.0,
          alt,
          Math.sin(angle) * radius + 250.0
        );
        desiredLook.set(60.0, 160.0, 250.0);
        break;
      }
    }

    if (personView) {
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (!this.initialized || this.activePresetId === 'pov') {
      this.currentPos.copy(desiredPos);
      this.currentLookAt.copy(desiredLook);
      this.initialized = true;
      this.followEntity = null; // the follow cameras re-anchor from here
    } else if (this.activePresetId === 'chase' || this.activePresetId === 'action') {
      // Smoothed in the followed entity's frame rather than in world space. A world-space follower trails a moving
      // target by a distance that depends on the frame time (about speed x dt), so with uneven frame times the camera
      // surged back and forth behind an accelerating or fast car. Relative to the entity a steady drive keeps the
      // camera steady, while turns, orbit drags, zoom & the speed pull-back are still eased. The entity's height is
      // eased in world space (curbs, park lawns, jumps, the helicopter climbing).
      if (this.followEntity !== entity) {
        // preset or mode switch: start from where the camera is and glide over to the new framing
        this.followEntity = entity;
        this.followBaseY = entity.position.y;
        this.followOffset.subVectors(this.currentPos, entity.position);
        this.followLookOffset.subVectors(this.currentLookAt, entity.position);
      }
      const k = 1 - Math.exp(-dt * 8.5);
      // The helicopter's climb is eased as the continuous motion it is: the camera trails it by climb / 8.5 m at any
      // frame time. Eased as a step per frame like a curb, the trail followed every uneven frame time, and the
      // helicopter bobbed on screen as it climbed or levelled off
      const climb = entity.type === 'helicopter' ? entity.verticalSpeed || 0 : 0;
      const trail = climb / 8.5;
      const lag = entity.position.y - this.followBaseY;
      this.followBaseY = entity.position.y - trail - (lag - climb * dt - trail) * (1 - k);
      this.followOffset.lerp(desiredPos.sub(entity.position), k);
      this.followLookOffset.lerp(desiredLook.sub(entity.position), k);
      this.currentPos.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followOffset);
      this.currentLookAt.set(entity.position.x, this.followBaseY, entity.position.z).add(this.followLookOffset);
      this.currentPos.y = Math.max(0.55, this.currentPos.y);
    } else {
      this.followEntity = null;
      const k = 1 - Math.exp(-dt * 8.5);
      this.currentPos.lerp(desiredPos, k);
      this.currentLookAt.lerp(desiredLook, k);
    }

    // A non-finite camera renders nothing at all: re-anchor on the next frame rather than keep a NaN framing
    const p = this.currentPos, l = this.currentLookAt;
    if (![p.x, p.y, p.z, l.x, l.y, l.z].every(Number.isFinite)) {
      this.currentPos.copy(this.camera.position);
      this.currentLookAt.set(0, 8, 440);
      this.initialized = false;
      this.followEntity = null;
      return;
    }
    this.camera.position.copy(this.currentPos);
    this.camera.lookAt(this.currentLookAt);

    // The direction the screen faces: what WASD and the stick move the body along on foot (controllers.js)
    const vx = l.x - p.x, vz = l.z - p.z;
    if (vx * vx + vz * vz > 1e-6) this.controllerManager.viewYaw = Math.atan2(vx, vz);

    const fov = personView ? PERSON_CAMERA.fov[this.activePresetId === 'pov' ? 'first' : 'third'] : this.getActivePreset().fov;
    const near = personView ? PERSON_CAMERA.near : DEFAULT_NEAR;
    if (this.camera.fov !== fov || this.camera.near !== near) {
      this.camera.fov = fov;
      this.camera.near = near;
      this.camera.updateProjectionMatrix();
    }
    if (document.pointerLockElement === this.domElement && !this.canLockPointer()) document.exitPointerLock?.();
  }

  // On foot: an over-the-shoulder spring arm in third person, the eyes in first. Writes currentPos and currentLookAt.
  updatePersonView(entity, dt) {
    const first = this.activePresetId === 'pov';
    const view = first ? 'first' : 'third';
    const look = this.personLook;
    const pivot = this._personPivot;
    const feet = entity.position;
    const arriving = this._personEntity !== entity || this._personReset;
    if (arriving || pivot.distanceToSquared(feet) > 36) {
      // Arriving on foot (or teleported): look the way the body faces, from right behind it
      if (arriving) {
        look.yaw = wrapAngle(entity.heading);
        look.pitch = PERSON_CAMERA.pitch;
      }
      pivot.copy(feet);
      this._personArm = NaN;
      this._personSide = NaN;
      this._personEntity = entity;
      this._personReset = false;
    }
    turnLook(look, 0, 0, view);

    // Back behind a body that is going somewhere, but only once the player has left the look alone a while, and never
    // swinging round in front of one that runs towards the camera
    this.lookIdle += dt;
    if (!first && !this.isDragging && this.lookIdle > PERSON_CAMERA.recenterAfter && Math.abs(entity.speed) > 0.5) {
      const d = wrapAngle(entity.heading - look.yaw);
      if (Math.abs(d) < 1.75) look.yaw = wrapAngle(look.yaw + d * (1 - Math.exp(-PERSON_CAMERA.recenterRate * dt)));
    }

    // Position follows with its own lag (none in first person, where any lag is felt as swimming); the look has none
    if (first) {
      pivot.copy(feet);
    } else {
      const k = 1 - Math.exp(-PERSON_CAMERA.followRate * dt);
      const ky = 1 - Math.exp(-PERSON_CAMERA.followRateY * dt);
      pivot.x += (feet.x - pivot.x) * k;
      pivot.z += (feet.z - pivot.z) * k;
      pivot.y += (feet.y - pivot.y) * ky;
    }

    const pose = personCameraPose(pivot, look, view, this.zoomMultiplier);
    let eye = pose.eye;
    let arm = 0;
    if (!first) {
      const reach = pose.arm + PERSON_CAMERA.shoulder + 2;
      const colliders = this.controllerManager.nearColliders?.(pose.pivot.x, pose.pivot.z, reach) || [];
      const free = springArm(colliders, pose);
      this._personSide = stepArm(this._personSide, free.side, dt);
      this._personArm = stepArm(this._personArm, free.arm, dt);
      arm = this._personArm;
      const sx = pose.pivot.x + pose.side.x * this._personSide, sz = pose.pivot.z + pose.side.z * this._personSide;
      eye = { x: sx - pose.dir.x * arm, y: pose.pivot.y - pose.dir.y * arm, z: sz - pose.dir.z * arm };
      // Looking up brings the lens down to the pavement, never under it
      const ground = this.controllerManager.getGroundHeight?.(eye.x, eye.z, 'person') ?? 0;
      eye.y = Math.max(ground + 0.25, eye.y);
    }
    this.currentPos.set(eye.x, eye.y, eye.z);
    this.currentLookAt.set(eye.x + pose.dir.x * 20, eye.y + pose.dir.y * 20, eye.z + pose.dir.z * 20);
    // The body is not drawn from inside its own head
    this.controllerManager.personView = view;
    this.controllerManager.personHidden = first || arm < 0.6;
  }
}

export { CAMERA_PRESETS, CameraSystem };
