import * as THREE from 'three/webgpu';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

// Building blocks shared by the vehicle models (cars.js, bus.js, helicopter.js).

// Tags a piece of a merged vehicle mesh with its material part id (indexed, with uvs, so all pieces merge)
function part(geometry, id) {
  const g = geometry.index ? geometry : mergeVertices(geometry);
  if (!g.attributes.uv) {
    g.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
  }
  g.setAttribute('partId', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count).fill(id), 1));
  return g;
}

// Section winding used by every vehicle loft: left (-x) bottom, up & over the top, right (+x) bottom
function mirrorSection(right, center, z) {
  const pts = [];
  for (const [x, y] of right) pts.push(new THREE.Vector3(-x, y, z));
  if (center) pts.push(new THREE.Vector3(center[0], center[1], z));
  for (let i = right.length - 1; i >= 0; i--) pts.push(new THREE.Vector3(right[i][0], right[i][1], z));
  return pts;
}

function roundedRectShape(hw, hh, r) {
  const s = new THREE.Shape();
  s.moveTo(-hw + r, -hh);
  s.lineTo(hw - r, -hh);
  s.quadraticCurveTo(hw, -hh, hw, -hh + r);
  s.lineTo(hw, hh - r);
  s.quadraticCurveTo(hw, hh, hw - r, hh);
  s.lineTo(-hw + r, hh);
  s.quadraticCurveTo(-hw, hh, -hw, hh - r);
  s.lineTo(-hw, -hh + r);
  s.quadraticCurveTo(-hw, -hh, -hw + r, -hh);
  return s;
}

// Rounded box extruded along z, centred on the origin
function roundedBox(hw, hh, depth, r, bevel = 0.012) {
  const g = new THREE.ExtrudeGeometry(roundedRectShape(hw - bevel, hh - bevel, Math.max(0.002, r - bevel)), {
    depth: Math.max(0.001, depth - 2 * bevel),
    bevelEnabled: true,
    bevelThickness: bevel,
    bevelSize: bevel,
    bevelSegments: 1,
    curveSegments: 2
  });
  return g.translate(0, 0, -(depth - 2 * bevel) / 2);
}

export { part, mirrorSection, roundedRectShape, roundedBox };
