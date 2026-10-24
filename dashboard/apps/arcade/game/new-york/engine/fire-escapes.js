import * as THREE from 'three/webgpu';
import {
  Fn, float, attribute, uv, positionGeometry, normalGeometry,
  abs, floor, fract, mod, step, fwidth, max, min, mix
} from 'three/tsl';

const MAX_ESCAPES = 2400;
const MAX_NEAR_FLOORS = 256;
const NEAR_DISTANCE = 90;
const STOREY = 3.5;

// A shared floor module: open landings, thin horizontal treads and masked iron railings.
// Parts 0/1 are the landing/guard; 2/3 the flight/guard; 4 the raised drop ladder.
function floorGeometry() {
  const positions = [], uvs = [], parts = [], indices = [];
  function quad(a, b, c, d, part, width = 1) {
    const first = positions.length / 3;
    for (const p of [a, b, c, d]) positions.push(...p);
    uvs.push(0, 0, width, 0, width, 1, 0, 1);
    parts.push(part, part, part, part);
    indices.push(first, first + 1, first + 2, first, first + 2, first + 3);
  }
  function deck(x0, x1, z0, z1, y, part) {
    quad([x0, y, z0], [x0, y, z1], [x1, y, z1], [x1, y, z0], part);
  }
  function guard(x0, z0, x1, z1, y0 = 0, y1 = 0, part = 1) {
    const bays = Math.round(Math.hypot(x1 - x0, z1 - z0) / 0.17);
    quad([x0, y0, z0], [x1, y1, z1], [x1, y1 + 1, z1], [x0, y0 + 1, z0], part, bays);
  }
  deck(-1.7, 1.7, -0.55, -0.18, 0, 0);
  deck(-1.7, -1.2, -0.18, 0.55, 0, 0);
  deck(1.2, 1.7, -0.18, 0.55, 0, 0);
  guard(-1.7, 0.55, 1.7, 0.55);
  guard(-1.7, -0.55, -1.7, 0.55);
  guard(1.7, 0.55, 1.7, -0.55);
  const steps = 16;
  for (let i = 0; i < steps; i++) {
    deck(-1.2 + 2.4 * i / steps, -1.2 + 2.4 * (i + 1) / steps, -0.15, 0.50, STOREY * (i + 1) / steps, 2);
  }
  for (const z of [-0.17, 0.52]) {
    quad([-1.2, -0.08, z], [1.2, STOREY - 0.08, z], [1.2, STOREY + 0.03, z], [-1.2, 0.03, z], 2);
    guard(-1.2, z, 1.2, z, 0, STOREY, 3);
  }
  quad([-1.62, -2.2, 0.56], [-1.28, -2.2, 0.56], [-1.28, -0.05, 0.56], [-1.62, -0.05, 0.56], 4);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geometry.setAttribute('escapePart', new THREE.Float32BufferAttribute(parts, 1));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

function flagRange(attribute, count) {
  if (!count) return;
  attribute.clearUpdateRanges();
  attribute.addUpdateRange(0, count * attribute.itemSize);
  attribute.needsUpdate = true;
}

export function createFireEscapes(group) {
  const steel = { color: 0x25292c, roughness: 0.65, metalness: 0.6 };
  const nearMaterial = new THREE.MeshStandardNodeMaterial({ ...steel, side: THREE.DoubleSide });
  nearMaterial.maskNode = Fn(() => {
    const part = attribute('escapePart', 'float');
    const flags = attribute('escapeFlags', 'vec2');
    const u = uv();
    const bar = (distance, halfWidth, footprint) => step(distance, max(halfWidth, footprint.mul(0.5)));
    const p = positionGeometry.xz;
    const grid = p.mul(10);
    const bars = bar(abs(fract(grid.add(0.5)).sub(0.5)), 0.08, fwidth(grid));
    // Frame the landing panels and their stair opening; unresolved grating fills in without shimmering.
    const edge = min(abs(abs(p.x).sub(1.7)), abs(abs(p.x).sub(1.2)), abs(abs(p.y).sub(0.55)), abs(p.y.add(0.18)));
    const frame = bar(edge, 0.025, max(fwidth(p.x), fwidth(p.y)));
    const solid = mix(max(bars.x, bars.y, frame), 1, step(0.5, part));
    const pickets = bar(abs(fract(u.x.add(0.5)).sub(0.5)), 0.08, fwidth(u.x));
    const rail = bar(abs(u.y.sub(0.97)), 0.03, fwidth(u.y));
    const middleRail = bar(abs(u.y.sub(0.48)), 0.018, fwidth(u.y));
    const guard = max(pickets, rail, middleRail);
    const ladderRails = bar(min(u.x, float(1).sub(u.x)), 0.065, fwidth(u.x));
    const rungs = bar(abs(fract(u.y.mul(8).add(0.5)).sub(0.5)), 0.07, fwidth(u.y).mul(8));
    const ladder = step(3.5, part);
    const flight = step(1.5, part).mul(float(1).sub(ladder));
    const visible = mix(1, flags.x, flight).mul(mix(1, flags.y, ladder));
    return mix(mix(solid, guard, mod(part, 2)), max(ladderRails, rungs), ladder).mul(visible).greaterThan(0.5);
  })();

  const geometry = floorGeometry();
  const mirrored = geometry.clone();
  mirrored.scale(-1, 1, 1);
  const index = mirrored.index.array;
  for (let i = 0; i < index.length; i += 3) {
    const temp = index[i + 1];
    index[i + 1] = index[i + 2];
    index[i + 2] = temp;
  }
  const near = [geometry, mirrored].map((g, i) => {
    g.setAttribute('escapeFlags', new THREE.InstancedBufferAttribute(new Float32Array(MAX_NEAR_FLOORS * 2), 2));
    const mesh = new THREE.InstancedMesh(g, nearMaterial, MAX_NEAR_FLOORS);
    mesh.name = `FireEscapesNear${i}`;
    return mesh;
  });

  const farGeometry = new THREE.BoxGeometry(1, 1, 1);
  const farData = new THREE.InstancedBufferAttribute(new Float32Array(MAX_ESCAPES * 2), 2);
  farGeometry.setAttribute('escapeSize', farData);
  const farMaterial = new THREE.MeshStandardNodeMaterial(steel);
  farMaterial.maskNode = Fn(() => {
    const size = attribute('escapeSize', 'vec2'); // Storey and total escape height.
    const across = positionGeometry.x.add(0.5).mul(3.4);
    const height = positionGeometry.y.add(0.5).mul(size.y);
    const level = height.div(size.x);
    const up = fract(level).mul(size.x);
    const py = fwidth(height);
    const px = fwidth(across);
    const bar = (distance, halfWidth, footprint) => step(distance, max(halfWidth, footprint.mul(0.5)));
    const front = abs(normalGeometry.z);
    const along = mix(positionGeometry.z.add(0.5).mul(1.1), across, front);
    const pickets = bar(abs(fract(along.div(0.17).add(0.5)).sub(0.5)).mul(0.17), 0.014, fwidth(along));
    const guards = max(pickets.mul(step(up, 1)), bar(abs(up.sub(0.97)), 0.03, py), bar(abs(up.sub(0.48)), 0.02, py));
    const deck = bar(abs(up.sub(0.04)), 0.05, py);
    const flightX = mix(across, float(3.4).sub(across), mod(floor(level), 2));
    const flightY = flightX.sub(0.5).mul(size.x.div(2.4));
    const slopeWidth = px.mul(size.x.div(2.4)).add(py);
    const stringer = bar(abs(up.sub(flightY)), 0.07, slopeWidth);
    const handrail = bar(abs(up.sub(flightY).sub(0.97)), 0.03, slopeWidth);
    const hasFlight = step(floor(level).add(1), floor(size.y.div(size.x)));
    const stairs = max(stringer, handrail).mul(step(0.5, flightX)).mul(step(flightX, 2.9)).mul(hasFlight).mul(front);
    // Open top and bottom: the distant proxy must not look like a solid roof over the stairwell.
    return max(deck, guards, stairs).mul(step(abs(normalGeometry.y), 0.5)).greaterThan(0.5);
  })();
  const far = new THREE.InstancedMesh(farGeometry, farMaterial, MAX_ESCAPES);
  far.name = 'FireEscapesFar';
  for (const mesh of [...near, far]) {
    mesh.count = 0;
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    group.add(mesh);
  }

  const dummy = new THREE.Object3D();
  const counts = [0, 0];
  let total = 0, nearFloors = 0, farCount = 0;
  return {
    begin() {
      total = nearFloors = farCount = counts[0] = counts[1] = 0;
    },
    add(fe, focusX, focusZ) {
      if (total >= MAX_ESCAPES) return;
      total++;
      const dx = fe.x - focusX, dz = fe.z - focusZ;
      dummy.rotation.set(0, (fe.ry || 0) + fe.facing, 0);
      if (dx * dx + dz * dz < NEAR_DISTANCE * NEAR_DISTANCE && nearFloors + fe.landings <= MAX_NEAR_FLOORS) {
        dummy.scale.set(1, fe.storey / STOREY, 1);
        for (let i = 0; i < fe.landings; i++) {
          const parity = i % 2, n = counts[parity]++;
          dummy.position.set(fe.x, fe.y + i * fe.storey, fe.z);
          dummy.updateMatrix();
          near[parity].setMatrixAt(n, dummy.matrix);
          near[parity].geometry.getAttribute('escapeFlags').setXY(n, i < fe.landings - 1 ? 1 : 0, i === 0 ? 1 : 0);
        }
        nearFloors += fe.landings;
      } else {
        dummy.position.set(fe.x, fe.y + fe.h * 0.5, fe.z);
        dummy.scale.set(3.4, fe.h, 1.1);
        dummy.updateMatrix();
        far.setMatrixAt(farCount, dummy.matrix);
        farData.setXY(farCount++, fe.storey, fe.h);
      }
    },
    end() {
      for (let i = 0; i < near.length; i++) {
        near[i].count = counts[i];
        flagRange(near[i].instanceMatrix, counts[i]);
        flagRange(near[i].geometry.getAttribute('escapeFlags'), counts[i]);
      }
      far.count = farCount;
      flagRange(far.instanceMatrix, farCount);
      flagRange(farData, farCount);
    }
  };
}
