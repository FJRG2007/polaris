// The other people in a call session, drawn as a coloured marker with their name
// over it. Positions arrive about ten times a second (`embed.js`), so each marker
// eases towards the last one it was given instead of jumping.
import * as THREE from 'three/webgpu';
import { onPlayers } from './embed.js';

const COLORS = [0xf05a4f, 0x3fa7f5, 0x4fc97a, 0xf5b83f, 0xb57cf2, 0x2fd0c8, 0xf27cc0, 0x9aa5b1];
const LIFT = { person: 2.6, cyclist: 2.8, car: 3.2, helicopter: 4.5 };

function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

export function createRemotePlayers(scene) {
  const geometry = new THREE.CapsuleGeometry(0.45, 1.1, 4, 12);
  const labels = document.createElement('div');
  labels.className = 'remote-labels';
  document.body.appendChild(labels);
  const markers = new Map();
  const projected = new THREE.Vector3();

  function remove(id) {
    const marker = markers.get(id);
    if (!marker) return;
    scene.remove(marker.mesh);
    marker.mesh.material.dispose();
    marker.label.remove();
    markers.delete(id);
  }

  onPlayers((players) => {
    const seen = new Set();
    for (const player of players) {
      seen.add(player.id);
      let marker = markers.get(player.id);
      if (!marker) {
        const material = new THREE.MeshStandardNodeMaterial({ color: colorFor(player.id), roughness: 0.5, emissive: colorFor(player.id), emissiveIntensity: 0.35 });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.position.set(player.x, player.y + LIFT[player.mode], player.z);
        scene.add(mesh);
        const label = document.createElement('div');
        label.className = 'remote-label';
        labels.appendChild(label);
        marker = { mesh, label, target: new THREE.Vector3() };
        markers.set(player.id, marker);
      }
      marker.target.set(player.x, player.y + LIFT[player.mode], player.z);
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
        marker.mesh.position.lerp(marker.target, ease);
        projected.copy(marker.mesh.position);
        projected.y += 1.4;
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
