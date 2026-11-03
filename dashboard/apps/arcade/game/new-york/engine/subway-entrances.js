import { BLOCKS, blockAt } from './city-config.js';
import { getStreetGroundHeight } from './city-grid.js';
import { SUBWAY_ENTRANCES } from './subway-geodata.js';
import { polygonBoxOverlaps } from './building-collision.js';

const HALF_WIDTH = 1.26;
const HALF_LENGTH = 3.21;
const MAX_SHIFT = 12;
const CELL_SIZE = 32;
const offsets = [];
for (let x = -MAX_SHIFT; x <= MAX_SHIFT; x += 0.75) {
  for (let z = -MAX_SHIFT; z <= MAX_SHIFT; z += 0.75) {
    if (x * x + z * z <= MAX_SHIFT * MAX_SHIFT) offsets.push([x, z]);
  }
}
offsets.sort((a, b) => a[0] ** 2 + a[1] ** 2 - b[0] ** 2 - b[1] ** 2);

function box(x, z, hx, hz, cs = 1, sn = 0) {
  const ex = Math.abs(cs) * hx + Math.abs(sn) * hz;
  const ez = Math.abs(sn) * hx + Math.abs(cs) * hz;
  return { x, z, hx, hz, cs, sn, minX: x - ex, maxX: x + ex, minZ: z - ez, maxZ: z + ez };
}

function overlaps(a, b) {
  if (a.maxX <= b.minX || a.minX >= b.maxX || a.maxZ <= b.minZ || a.minZ >= b.maxZ) return false;
  if (b.polygon) return polygonBoxOverlaps(b.polygon, a.x, a.z, a.hx, a.hz, a.cs, a.sn);
  const dx = b.x - a.x, dz = b.z - a.z;
  const c = Math.abs(a.cs * b.cs + a.sn * b.sn), s = Math.abs(a.cs * b.sn - a.sn * b.cs);
  return Math.abs(dx * a.cs - dz * a.sn) < a.hx + b.hx * c + b.hz * s
    && Math.abs(dx * a.sn + dz * a.cs) < a.hz + b.hx * s + b.hz * c
    && Math.abs(dx * b.cs - dz * b.sn) < b.hx + a.hx * c + a.hz * s
    && Math.abs(dx * b.sn + dz * b.cs) < b.hz + a.hx * s + a.hz * c;
}

// Adapt surveyed entrances to the generated sidewalks once, without moving them across a street.
function createSubwayEntrances(colliders, occupied = []) {
  const cells = new Map();
  function visitCells(b, callback) {
    for (let x = Math.floor(b.minX / CELL_SIZE); x <= Math.floor(b.maxX / CELL_SIZE); x++) {
      for (let z = Math.floor(b.minZ / CELL_SIZE); z <= Math.floor(b.maxZ / CELL_SIZE); z++) {
        if (callback(`${x},${z}`)) return true;
      }
    }
    return false;
  }
  function insert(b) {
    visitCells(b, (key) => {
      if (!cells.has(key)) cells.set(key, []);
      cells.get(key).push(b);
    });
  }
  for (const c of [...colliders, ...occupied]) {
    if ((c.minY ?? 0) >= 2.8 || (c.maxY ?? Infinity) <= 0.22) continue;
    if (c.polygon) { insert(c); continue; }
    const o = c.obb;
    insert(o ? box(o.cx, o.cz, o.hx, o.hz, o.cs, o.sn)
      : box((c.minX + c.maxX) / 2, (c.minZ + c.maxZ) / 2, (c.maxX - c.minX) / 2, (c.maxZ - c.minZ) / 2));
  }
  for (const b of BLOCKS) {
    if (b.park > 0.6 || b.median) continue;
    for (const [angle, px, pz, rects] of b.frames || [[0, 0, 0, b.rects]]) {
      const cs = Math.cos(angle), sn = Math.sin(angle);
      for (const [x0, x1, z0, z1] of rects) {
        const x = (x0 + x1) / 2 - px, z = (z0 + z1) / 2 - pz;
        insert(box(px + x * cs + z * sn, pz - x * sn + z * cs, (x1 - x0) / 2, (z1 - z0) / 2, cs, sn));
      }
    }
  }

  const sites = [];
  for (const [sourceX, sourceZ, stationIndex] of SUBWAY_ENTRANCES) {
    let block = blockAt(sourceX, sourceZ);
    const edges = [];
    for (const b of block ? [block] : BLOCKS) {
      if ((!block && b.median) || sourceX < b.minX - MAX_SHIFT || sourceX > b.maxX + MAX_SHIFT
        || sourceZ < b.minZ - MAX_SHIFT || sourceZ > b.maxZ + MAX_SHIFT) continue;
      for (let i = 0; i < b.poly.length; i++) {
        const a = b.poly[i], p = b.poly[(i + 1) % b.poly.length];
        const dx = p.x - a.x, dz = p.z - a.z, length = Math.hypot(dx, dz);
        if (length < 0.1) continue;
        const t = Math.max(0, Math.min(length, ((sourceX - a.x) * dx + (sourceZ - a.z) * dz) / length));
        const distance = Math.hypot(a.x + dx * t / length - sourceX, a.z + dz * t / length - sourceZ);
        if (block || distance <= MAX_SHIFT) edges.push({ block: b, distance, yaw: Math.atan2(dx, dz) + (t < length / 2 ? Math.PI : 0) });
      }
    }
    edges.sort((a, b) => a.distance - b.distance);
    if (!edges.length) continue;
    block = edges[0].block;
    const directions = edges.filter((e) => e.block === block).slice(0, 2);
    let site = null;
    for (const [dx, dz] of offsets) {
      const x = sourceX + dx, z = sourceZ + dz;
      if (blockAt(x, z) !== block) continue;
      for (const { yaw } of directions) {
        const b = box(x, z, HALF_WIDTH, HALF_LENGTH, Math.cos(yaw), Math.sin(yaw));
        if (visitCells(b, (key) => cells.get(key)?.some((c) => overlaps(b, c)))) continue;
        let fits = true;
        for (const px of [-HALF_WIDTH, 0, HALF_WIDTH]) {
          for (let i = 0; i <= 8; i++) {
            const pz = -HALF_LENGTH + i * HALF_LENGTH / 4;
            if (blockAt(x + px * b.cs + pz * b.sn, z - px * b.sn + pz * b.cs) !== block) fits = false;
          }
        }
        if (!fits) continue;
        insert(b);
        site = { x, z, yaw, stationIndex };
        let ground = 0.22;
        for (const px of [-HALF_WIDTH, 0, HALF_WIDTH]) {
          for (const pz of [-HALF_LENGTH, 0, HALF_LENGTH]) {
            ground = Math.max(ground, getStreetGroundHeight(x + px * b.cs + pz * b.sn, z - px * b.sn + pz * b.cs));
          }
        }
        site.y = ground - 0.22;
        break;
      }
      if (site) break;
    }
    if (site) sites.push(site);
  }
  return sites;
}

export { createSubwayEntrances };
