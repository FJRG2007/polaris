// js/hit-resolution.js
// Where a bullet stops: the nearest of the city's colliders (axis-aligned boxes: { minX, maxX, minZ, maxZ, minY?,
// maxY }) and the targets' hit spheres. World first, so nobody is shot through a wall; then the body part hit sets
// the damage multiplier (the head is the weak point). Slab test after Kay & Kajiya 1986; ray-sphere in closed form.

const PART_MULTIPLIER = { head: 2.5, body: 1, legs: 0.7 };

/** Distance along a unit ray to an axis-aligned box, or Infinity. */
function rayBox(ox, oy, oz, dx, dy, dz, box, maxDistance = Infinity) {
  let near = 0;
  let far = maxDistance;
  const axes = [
    [ox, dx, box.minX, box.maxX],
    [oy, dy, box.minY ?? 0, box.maxY ?? Infinity],
    [oz, dz, box.minZ, box.maxZ]
  ];
  for (const [o, d, min, max] of axes) {
    if (Math.abs(d) < 1e-9) {
      if (o < min || o > max) return Infinity;
      continue;
    }
    let t1 = (min - o) / d;
    let t2 = (max - o) / d;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > near) near = t1;
    if (t2 < far) far = t2;
    if (near > far) return Infinity;
  }
  return near;
}

/** Distance along a unit ray to a sphere, or Infinity (a ray starting inside counts as a hit at 0). */
function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, radius) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz;
  const along = lx * dx + ly * dy + lz * dz;
  const d2 = lx * lx + ly * ly + lz * lz - along * along;
  const r2 = radius * radius;
  if (d2 > r2) return Infinity;
  const half = Math.sqrt(r2 - d2);
  const t = along - half;
  if (t >= 0) return t;
  return along + half >= 0 ? 0 : Infinity;
}

/** The nearest world collider along the ray within `maxDistance`: { distance, collider } or null. */
function castWorld(origin, dir, maxDistance, colliders) {
  let best = maxDistance;
  let hit = null;
  for (const c of colliders) {
    const t = rayBox(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, c, best);
    if (t < best) {
      best = t;
      hit = c;
    }
  }
  return hit ? { distance: best, collider: hit } : null;
}

/**
 * Resolves one bullet. `targets`: [{ id, alive, parts: [{ part, x, y, z, radius }] }].
 * Returns { kind: 'target' | 'world' | 'none', distance, target?, part?, multiplier?, point }.
 */
function resolveShot(origin, dir, maxDistance, colliders, targets) {
  const world = castWorld(origin, dir, maxDistance, colliders);
  let limit = world ? world.distance : maxDistance;
  let best = null;
  for (const target of targets) {
    if (target.alive === false) continue;
    for (const p of target.parts) {
      const t = raySphere(origin.x, origin.y, origin.z, dir.x, dir.y, dir.z, p.x, p.y, p.z, p.radius);
      if (t < limit) {
        limit = t;
        best = { target, part: p.part };
      }
    }
  }
  const point = (t) => ({ x: origin.x + dir.x * t, y: origin.y + dir.y * t, z: origin.z + dir.z * t });
  if (best) {
    return {
      kind: 'target', distance: limit, target: best.target, part: best.part,
      multiplier: PART_MULTIPLIER[best.part] ?? 1, point: point(limit)
    };
  }
  if (world) return { kind: 'world', distance: world.distance, collider: world.collider, point: point(world.distance) };
  return { kind: 'none', distance: maxDistance, point: point(maxDistance) };
}

/** True when nothing in the city stands between two points. */
function lineOfSight(a, b, colliders) {
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-6) return true;
  return !castWorld(a, { x: dx / length, y: dy / length, z: dz / length }, length, colliders);
}

/** Damage falls off past 60% of a weapon's range, to 40% at full range. */
function falloff(distance, range) {
  if (distance <= range * 0.6) return 1;
  return Math.max(0.4, 1 - ((distance - range * 0.6) / (range * 0.4)) * 0.6);
}

export { PART_MULTIPLIER, castWorld, falloff, lineOfSight, rayBox, raySphere, resolveShot };
