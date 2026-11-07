// js/arrival-placement.js
// Where a body arrives when the player switches mode or jumps on the map: kept free of the scene so it can be checked
// on its own. The caller supplies `clear(point, heading)`, which tests the body's whole footprint against buildings,
// landmarks, street furniture, traffic and the other bodies; this module only decides which points to try, in order.

// Lanes further than this from the player are not "the street beside them": the body arrives on open ground instead
const LANE_REACH = 48;
// Spacing of the points tried along each lane, either side of the one nearest the player
const LANE_STEP = 3;
// Ring search: 4 m rings out to 256 m (as before), then 16 m rings out to 640 m, 32 points per ring
const NEAR_RING_STEP = 4, NEAR_RING_MAX = 256, FAR_RING_STEP = 16, FAR_RING_MAX = 640, RING_POINTS = 32;

/** The heading (forward = (sin, cos)) of a direction (dx, dz). */
const headingOf = (dx, dz) => Math.atan2(dx, dz);

/**
 * Points along the drivable lanes near (x, z), nearest first: for every lane of every directed edge within LANE_REACH,
 * its point closest to (x, z) and points LANE_STEP apart either side of it, each with the lane's own heading. Edges are
 * the road network's (start sx/sz, unit direction dx/dz, right normal rx/rz, length len, lateral lane offsets lanes).
 */
function laneCandidates(edges, x, z, reach = LANE_REACH) {
  const out = [];
  for (const e of edges || []) {
    if (!e || !Number.isFinite(e.sx) || !Number.isFinite(e.len) || !e.lanes?.length) continue;
    const along = (x - e.sx) * e.dx + (z - e.sz) * e.dz;
    const nearest = Math.max(0, Math.min(e.len, along));
    // Cheap reject on the centre line before walking the lanes
    const cx = e.sx + e.dx * nearest, cz = e.sz + e.dz * nearest;
    const widest = Math.max(...e.lanes.map(Math.abs));
    if (Math.hypot(x - cx, z - cz) > reach + widest) continue;
    const heading = headingOf(e.dx, e.dz);
    for (const offset of e.lanes) {
      for (let k = 0; k * LANE_STEP <= reach; k++) {
        for (const side of k ? [-1, 1] : [1]) {
          const s = nearest + side * k * LANE_STEP;
          if (s < 0 || s > e.len) continue;
          const px = e.sx + e.dx * s + e.rx * offset, pz = e.sz + e.dz * s + e.rz * offset;
          const distance = Math.hypot(px - x, pz - z);
          if (distance <= reach) out.push({ x: px, z: pz, heading, distance });
        }
      }
    }
  }
  return out.sort((a, b) => a.distance - b.distance);
}

/**
 * The arrival for a body leaving from (x, z) facing `heading`. A road vehicle (`onRoad`) takes the nearest clear lane
 * point, facing along the lane; otherwise, or with no clear lane in reach, the spot itself when clear, then the nearest
 * clear point on rings around it, facing the way the player faced. `clamp(point)` keeps a point on the map (null when
 * the shore leaves nowhere). Returns { x, z, heading } or null when nothing is clear: the caller then keeps the body
 * where it was, as before.
 */
function placeArrival({ x, z, heading = Math.PI, onRoad = false, edges = [], clear, clamp = (p) => p }) {
  if (!Number.isFinite(x) || !Number.isFinite(z) || typeof clear !== 'function') return null;
  if (!Number.isFinite(heading)) heading = Math.PI;
  if (onRoad) {
    for (const lane of laneCandidates(edges, x, z)) {
      const p = clamp({ x: lane.x, z: lane.z });
      if (p && clear(p, lane.heading)) return { x: p.x, z: p.z, heading: lane.heading };
    }
  }
  const origin = clamp({ x, z });
  if (origin && clear(origin, heading)) return { x: origin.x, z: origin.z, heading };
  const cx = origin ? origin.x : x, cz = origin ? origin.z : z;
  for (let distance = NEAR_RING_STEP; distance <= FAR_RING_MAX; distance += distance < NEAR_RING_MAX ? NEAR_RING_STEP : FAR_RING_STEP) {
    for (let i = 0; i < RING_POINTS; i++) {
      const angle = (i * 2 * Math.PI) / RING_POINTS;
      const p = clamp({ x: cx + Math.cos(angle) * distance, z: cz + Math.sin(angle) * distance });
      if (p && clear(p, heading)) return { x: p.x, z: p.z, heading };
    }
  }
  return null;
}

/** Whether a circle of `radius` at (x, z) overlaps any of `bodies` ({ x, z, radius }). */
function overlapsBodies(bodies, x, z, radius) {
  for (const b of bodies || []) if (Math.hypot(b.x - x, b.z - z) < b.radius + radius) return true;
  return false;
}

/** Whether a circle of `radius` at (x, z) overlaps any axis-aligned footprint ({ minX, maxX, minZ, maxZ }). */
function overlapsFootprints(footprints, x, z, radius) {
  for (const f of footprints || []) {
    const nx = Math.max(f.minX, Math.min(f.maxX, x)), nz = Math.max(f.minZ, Math.min(f.maxZ, z));
    if (Math.hypot(nx - x, nz - z) < radius) return true;
  }
  return false;
}

export { FAR_RING_MAX, LANE_REACH, headingOf, laneCandidates, overlapsBodies, overlapsFootprints, placeArrival };
