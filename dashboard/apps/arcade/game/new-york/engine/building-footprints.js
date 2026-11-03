import * as THREE from 'three/webgpu';
import { WALL_KINDS } from './tsl-materials.js';
import { polygonContains } from './building-collision.js';

function partyWallHeight(record, a, b, neighbours) {
  const dx = b.x - a.x, dz = b.y - a.y, length = Math.hypot(dx, dz);
  let height = 0;
  // Sample along the wall so a single touching corner does not blank the entire facade.
  for (const t of [0.15, 0.5, 0.85]) {
    const x = a.x + dx * t - dz / length, z = a.y + dz * t + dx / length;
    let roof = 0;
    for (const n of neighbours) {
      if (n.polygons === record.polygons || n.height <= 0 ||
        x < n.x0 || x > n.x1 || z < n.z0 || z > n.z1) continue;
      if (n.polygons.some(p => polygonContains(p, x, z))) roof = Math.max(roof, n.height);
    }
    if (!roof) return 0;
    height = Math.max(height, roof);
  }
  return height;
}

// One merged facade/roof mesh per 1 km cell. Explicit wall coordinates keep window bays metre-sized on any angle.
function createBuildingFootprints(material, records, getNeighbours) {
  const cells = new Map();
  records.forEach((record, index) => {
    if (!(record.height > 0)) return;
    const key = Math.floor(record.cx / 1000) + ',' + Math.floor(record.cz / 1000);
    let cell = cells.get(key);
    if (!cell) cells.set(key, (cell = { positions: [], normals: [], indices: [], boxes: [], walls: [] }));
    const height = record.height, top = height + 0.22;
    const seed = Math.floor(record.seed ?? index * 29) % 1000 + 0.1 + 0.8 * (record.tone ?? 0.5);
    const neighbours = getNeighbours && height <= 60 ? getNeighbours(record) : [];

    for (const polygon of record.polygons) {
      const rings = [polygon.outer, ...(polygon.holes || [])].map((ring, i) => {
        const points = ring.map(p => new THREE.Vector2(p.x, p.z));
        if (points.length > 1 && points[0].equals(points[points.length - 1])) points.pop();
        // Clockwise outer walls face away from the building; courtyard walls face into their holes.
        if (THREE.ShapeUtils.isClockWise(points) !== (i === 0)) points.reverse();
        return points;
      });
      if (rings[0].length < 3) continue;
      rings.forEach((ring, i) => {
        for (let j = 0; j < ring.length; j++) {
          const a = ring[j], b = ring[(j + 1) % ring.length];
          const dx = b.x - a.x, dz = b.y - a.y, width = Math.hypot(dx, dz);
          if (width === 0) continue;
          const offset = cell.positions.length / 3;
          const adjacentHeight = !i && neighbours.length ? partyWallHeight(record, a, b, neighbours) : 0;
          const kind = i ? WALL_KINDS.rear : adjacentHeight ? WALL_KINDS.lotLine
            : record.storefronts ? WALL_KINDS.shop : WALL_KINDS.front;
          const exposedHeight = adjacentHeight ? Math.max(0, top - adjacentHeight) : height;
          // Match the positive-world-axis tangent used by the shared interior-map view ray.
          const reverse = (Math.abs(dz) >= Math.abs(dx) ? dz : dx) < 0;
          cell.positions.push(a.x, 0.22, a.y, b.x, 0.22, b.y, a.x, top, a.y, b.x, top, b.y);
          for (let k = 0; k < 4; k++) {
            cell.normals.push(-dz / width, 0, dx / width);
            // Footprint walls use the box's unused depth for the exposed height above adjoining roofs.
            cell.boxes.push(width, height, exposedHeight, seed);
            cell.walls.push(reverse ? 1 - k % 2 : k % 2, k < 2 ? height : 0, kind);
          }
          cell.indices.push(offset, offset + 1, offset + 2, offset + 2, offset + 1, offset + 3);
        }
      });
      const triangles = THREE.ShapeUtils.triangulateShape(rings[0], rings.slice(1));
      const points = rings.flat(), offset = cell.positions.length / 3;
      for (const p of points) {
        cell.positions.push(p.x, top, p.y);
        cell.normals.push(0, 1, 0);
        cell.boxes.push(1, height, height, seed);
        cell.walls.push(0, 0, WALL_KINDS.front);
      }
      for (const [a, b, c] of triangles) cell.indices.push(offset + a, offset + c, offset + b);
    }
  });

  const group = new THREE.Group();
  group.name = 'SurveyedBuildings';
  let first;
  for (const cell of cells.values()) {
    if (cell.indices.length === 0) continue;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(cell.positions, 3));
    geometry.setAttribute('normal', new THREE.Float32BufferAttribute(cell.normals, 3));
    geometry.setAttribute('box', new THREE.Float32BufferAttribute(cell.boxes, 4));
    geometry.setAttribute('facadeWall', new THREE.Float32BufferAttribute(cell.walls, 3));
    geometry.setIndex(cell.indices);
    geometry.computeBoundingSphere();
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = 'SurveyedBuildingChunk';
    mesh.castShadow = mesh.receiveShadow = true;
    // Most cells are too small for scene-culling.js to pick them as big casters on its own: opt in to its stand-ins.
    mesh.userData.shadowStandIn = true;
    if (first) mesh.userData.sharesPipelineWith = first;
    else first = mesh;
    group.add(mesh);
  }
  return group;
}

export { createBuildingFootprints };
