// The other people in a call session, each drawn in what they are in - on foot,
// on a bike, in a car or in a helicopter - turned the way they face, in their
// own colour, with their name over them. Positions arrive about ten times a
// second (`embed.js`), so each one eases towards the last it was given instead
// of jumping.
import * as THREE from 'three/webgpu';
import { onPlayers } from './embed.js';
import {
  BODY_SPECS,
  buildCarGeometry,
  createLoftedCarMaterial,
  buildHelicopterBodyGeometry,
  buildHelicopterMainRotorGeometry,
  buildHelicopterTailRotorGeometry,
  createLoftedHelicopterMaterial
} from './actor-models.js';

const COLORS = [0xf05a4f, 0x3fa7f5, 0x4fc97a, 0xf5b83f, 0xb57cf2, 0x2fd0c8, 0xf27cc0, 0x9aa5b1];
// How far above where a player is their name is drawn.
const LABEL_HEIGHT = { person: 2.2, cyclist: 2.6, car: 2.2, helicopter: 3.6 };

function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

// Built the first time somebody needs them, and shared by every player.
let shared = null;
function sharedParts() {
  if (shared) return shared;
  shared = {
    body: new THREE.CapsuleGeometry(0.3, 1.1, 4, 12).translate(0, 0.85, 0),
    wheel: new THREE.TorusGeometry(0.35, 0.04, 8, 20).rotateY(Math.PI / 2),
    tire: new THREE.MeshStandardNodeMaterial({ color: 0x181a1e, roughness: 0.6 }),
    car: null,
    heli: null
  };
  return shared;
}

function carGeometry() {
  const parts = sharedParts();
  parts.car ??= buildCarGeometry(BODY_SPECS.sedan);
  return parts.car;
}

function heliGeometry() {
  const parts = sharedParts();
  parts.heli ??= {
    body: buildHelicopterBodyGeometry(),
    mainRotor: buildHelicopterMainRotorGeometry(),
    tailRotor: buildHelicopterTailRotorGeometry()
  };
  return parts.heli;
}

// What one player is in, at the origin and facing +z like the player's own models
// in `controllers.js`. Returns the group, the material it alone owns (to dispose
// of) and the rotors to spin.
function buildModel(mode, paint) {
  const root = new THREE.Group();
  const rotors = [];
  let owned = null;
  if (mode === 'car') {
    const body = new THREE.Mesh(carGeometry(), createLoftedCarMaterial(BODY_SPECS.sedan, paint));
    body.castShadow = true;
    root.add(body);
  } else if (mode === 'helicopter') {
    const heli = heliGeometry();
    const material = createLoftedHelicopterMaterial();
    const body = new THREE.Mesh(heli.body, material);
    body.castShadow = true;
    const main = new THREE.Mesh(heli.mainRotor, material);
    main.position.set(0, 2.66, -0.35);
    const tail = new THREE.Mesh(heli.tailRotor, material);
    tail.position.set(0.18, 2.02, -5.62);
    root.add(body, main, tail);
    rotors.push({ mesh: main, axis: 'y', speed: 38 }, { mesh: tail, axis: 'x', speed: 60 });
  } else {
    const parts = sharedParts();
    owned = new THREE.MeshStandardNodeMaterial({ color: paint, roughness: 0.5, emissive: paint, emissiveIntensity: 0.35 });
    const rider = new THREE.Mesh(parts.body, owned);
    rider.castShadow = true;
    root.add(rider);
    if (mode === 'cyclist') {
      rider.position.y = 0.45;
      for (const z of [0.58, -0.58]) {
        const wheel = new THREE.Mesh(parts.wheel, parts.tire);
        wheel.position.set(0, 0.38, z);
        root.add(wheel);
      }
    }
  }
  return { root, owned, rotors };
}

export function createRemotePlayers(scene) {
  const labels = document.createElement('div');
  labels.className = 'remote-labels';
  document.body.appendChild(labels);
  const markers = new Map();
  const projected = new THREE.Vector3();

  function dress(marker, mode) {
    if (marker.model) {
      marker.root.remove(marker.model.root);
      marker.model.owned?.dispose();
    }
    marker.model = buildModel(mode, marker.paint);
    marker.mode = mode;
    marker.root.add(marker.model.root);
  }

  function remove(id) {
    const marker = markers.get(id);
    if (!marker) return;
    scene.remove(marker.root);
    marker.model.owned?.dispose();
    marker.label.remove();
    markers.delete(id);
  }

  onPlayers((players) => {
    const seen = new Set();
    for (const player of players) {
      seen.add(player.id);
      let marker = markers.get(player.id);
      if (!marker) {
        const root = new THREE.Group();
        root.position.set(player.x, player.y, player.z);
        root.rotation.y = player.heading;
        scene.add(root);
        const label = document.createElement('div');
        label.className = 'remote-label';
        labels.appendChild(label);
        marker = { root, label, paint: colorFor(player.id), model: null, mode: null, target: new THREE.Vector3(), heading: player.heading };
        markers.set(player.id, marker);
      }
      if (marker.mode !== player.mode) dress(marker, player.mode);
      marker.target.set(player.x, player.y, player.z);
      marker.heading = player.heading;
      marker.label.textContent = player.name;
    }
    for (const id of [...markers.keys()]) if (!seen.has(id)) remove(id);
  });

  return {
    update(dt, camera) {
      if (markers.size === 0) return;
      const ease = 1 - Math.exp(-dt * 10);
      const width = window.innerWidth;
      const height = window.innerHeight;
      for (const marker of markers.values()) {
        marker.root.position.lerp(marker.target, ease);
        const turn = marker.heading - marker.root.rotation.y;
        marker.root.rotation.y += Math.atan2(Math.sin(turn), Math.cos(turn)) * ease;
        for (const rotor of marker.model.rotors) rotor.mesh.rotation[rotor.axis] += rotor.speed * dt;
        projected.copy(marker.root.position);
        projected.y += LABEL_HEIGHT[marker.mode];
        projected.project(camera);
        const visible = projected.z > -1 && projected.z < 1 && Math.abs(projected.x) <= 1 && Math.abs(projected.y) <= 1;
        marker.label.hidden = !visible;
        if (visible) {
          marker.label.style.transform = `translate(${(projected.x * 0.5 + 0.5) * width}px, ${(-projected.y * 0.5 + 0.5) * height}px) translate(-50%, -100%)`;
        }
      }
    }
  };
}
