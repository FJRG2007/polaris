function polygonContains(polygon, x, z) {
  let inside = false;
  for (let r = -1; r < polygon.holes.length; r++) {
    const ring = r < 0 ? polygon.outer : polygon.holes[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[i], b = ring[j];
      if ((a.z > z) !== (b.z > z) && x < a.x + (b.x - a.x) * (z - a.z) / (b.z - a.z)) inside = !inside;
    }
  }
  return inside;
}

// Test the actual outline, including courtyards, after the caller's cheap bounds check.
function polygonBoxOverlaps(polygon, x, z, hx, hz, cs = 1, sn = 0) {
  if (polygonContains(polygon, x, z)) return true;
  for (let r = -1; r < polygon.holes.length; r++) {
    const ring = r < 0 ? polygon.outer : polygon.holes[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i];
      const ax = (a.x - x) * cs - (a.z - z) * sn, az = (a.x - x) * sn + (a.z - z) * cs;
      const dx = (b.x - a.x) * cs - (b.z - a.z) * sn, dz = (b.x - a.x) * sn + (b.z - a.z) * cs;
      let lo = 0, hi = 1;
      if (Math.abs(dx) < 1e-10) {
        if (Math.abs(ax) >= hx) continue;
      } else {
        const t0 = (-hx - ax) / dx, t1 = (hx - ax) / dx;
        lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      }
      if (Math.abs(dz) < 1e-10) {
        if (Math.abs(az) >= hz) continue;
      } else {
        const t0 = (-hz - az) / dz, t1 = (hz - az) / dz;
        lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
      }
      if (hi - lo > 1e-10) return true;
    }
  }
  return false;
}

function polygonContact(polygon, x, z, body, contact) {
  if (body.car) {
    const { hx, hz, cos, sin } = body;
    if (!polygonBoxOverlaps(polygon, x, z, hx, hz, cos, sin)) return false;
    if (!contact) return true;
    let best = Infinity, outNx = 0, outNz = 0;
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const tryDir = (ux, uz, dist) => {
      if (!(dist >= 0) || dist >= best || !Number.isFinite(ux + uz)) return;
      const step = dist + 1e-6;
      if (polygonBoxOverlaps(polygon, x + ux * step, z + uz * step, hx, hz, cos, sin)) return;
      best = dist; outNx = ux; outNz = uz;
    };
    const pushSigned = (ux, uz, s) => {
      if (s >= -1e-9) tryDir(ux, uz, Math.max(0, s));
      if (s <= 1e-9) tryDir(-ux, -uz, Math.max(0, -s));
    };
    const tryVec = (dx, dz) => {
      const length = Math.hypot(dx, dz);
      if (length > 0) tryDir(dx / length, dz / length, length);
    };
    // Whole-outline escape candidates avoid the internal seams of triangulated colliders.
    for (let r = -1; r < polygon.holes.length; r++) {
      const ring = r < 0 ? polygon.outer : polygon.holes[r];
      const n = ring.length;
      if (n === 0) continue;
      let prevNx = 0, prevNz = 0, prevSup = 0, hasPrev = false;
      for (let k = n - 1; k >= 0; k--) {
        const p0 = ring[k], p1 = ring[(k + 1) % n];
        const len0 = Math.hypot(p1.x - p0.x, p1.z - p0.z);
        if (len0 > 0) {
          prevNx = -(p1.z - p0.z) / len0;
          prevNz = (p1.x - p0.x) / len0;
          prevSup = Math.abs(prevNx * cos - prevNz * sin) * hx + Math.abs(prevNx * sin + prevNz * cos) * hz;
          hasPrev = true;
          break;
        }
      }
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const a = ring[j], b = ring[i];
        if (a.x < minX) minX = a.x;
        if (a.x > maxX) maxX = a.x;
        if (a.z < minZ) minZ = a.z;
        if (a.z > maxZ) maxZ = a.z;
        const dx = a.x - x, dz = a.z - z;
        const ex = b.x - a.x, ez = b.z - a.z, length = Math.hypot(ex, ez);
        if (length > 0) {
          const nx = -ez / length, nz = ex / length;
          const d = dx * nx + dz * nz;
          const support = Math.abs(nx * cos - nz * sin) * hx + Math.abs(nx * sin + nz * cos) * hz;
          pushSigned(nx, nz, d + support);
          pushSigned(nx, nz, d - support);
          if (hasPrev) {
            const det = prevNx * nz - prevNz * nx;
            if (Math.abs(det) > 1e-6) {
              const d0 = dx * prevNx + dz * prevNz;
              for (const s0 of [-prevSup, prevSup]) {
                const c0 = d0 + s0;
                for (const s1 of [-support, support]) {
                  const c1 = d + s1;
                  tryVec((c0 * nz - c1 * prevNz) / det, (prevNx * c1 - nx * c0) / det);
                }
              }
            }
          }
          prevNx = nx; prevNz = nz; prevSup = support; hasPrev = true;
        }
        const u = dx * cos - dz * sin, v = dx * sin + dz * cos;
        pushSigned(cos, -sin, u + hx);
        pushSigned(cos, -sin, u - hx);
        pushSigned(sin, cos, v + hz);
        pushSigned(sin, cos, v - hz);
        for (const su of [-hx, hx]) {
          const du = u + su;
          for (const sv of [-hz, hz]) {
            const dv = v + sv;
            tryVec(du * cos + dv * sin, -du * sin + dv * cos);
          }
        }
        const d = Math.hypot(dx, dz);
        if (d > 0) {
          const support = (Math.abs(u) * hx + Math.abs(v) * hz) / d;
          pushSigned(dx / d, dz / d, d + support);
          pushSigned(dx / d, dz / d, d - support);
        }
      }
    }
    if (!Number.isFinite(best) && minX <= maxX) {
      const extX = Math.abs(cos) * hx + Math.abs(sin) * hz;
      const extZ = Math.abs(sin) * hx + Math.abs(cos) * hz;
      pushSigned(1, 0, maxX + extX - x);
      pushSigned(1, 0, minX - extX - x);
      pushSigned(0, 1, maxZ + extZ - z);
      pushSigned(0, 1, minZ - extZ - z);
    }
    if (!Number.isFinite(best)) return false;
    contact.nx = outNx; contact.nz = outNz; contact.depth = best + 1e-6;
    return true;
  }

  if (!circleContact(polygon, x, z, body.radius, contact)) return false;
  if (contact) {
    let dx = contact.nx * (contact.depth + 1e-6), dz = contact.nz * (contact.depth + 1e-6);
    // A concave corner may touch two walls. Resolve both before returning one combined push.
    for (let i = 0; i < 4; i++) {
      if (!circleContact(polygon, x + dx, z + dz, body.radius, contact)) {
        const depth = Math.hypot(dx, dz);
        if (depth > 0) {
          contact.depth = depth; contact.nx = dx / depth; contact.nz = dz / depth;
          return true;
        }
        break;
      }
      dx += contact.nx * (contact.depth + 1e-6); dz += contact.nz * (contact.depth + 1e-6);
    }
    // If dropped into a space narrower than the body, find an exit for its enclosing square.
    return polygonContact(polygon, x, z, { car: true, hx: body.radius, hz: body.radius, cos: 1, sin: 0 }, contact);
  }
  return true;
}

function circleContact(polygon, x, z, radius, contact) {
  const inside = polygonContains(polygon, x, z);
  let distance = Infinity, nx = 0, nz = 0, edgeX = 0, edgeZ = 0;
  for (let r = -1; r < polygon.holes.length; r++) {
    const ring = r < 0 ? polygon.outer : polygon.holes[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i], dx = b.x - a.x, dz = b.z - a.z;
      if (dx === 0 && dz === 0) continue;
      const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
      const qx = x - a.x - dx * t, qz = z - a.z - dz * t, d = Math.hypot(qx, qz);
      if (d < distance) { distance = d; nx = qx; nz = qz; edgeX = dx; edgeZ = dz; }
    }
  }
  if (!Number.isFinite(distance) || (!inside && distance >= radius)) return false;
  if (contact) {
    if (distance > 1e-10) {
      const sign = inside ? -1 : 1;
      nx *= sign / distance; nz *= sign / distance;
    } else {
      const length = Math.hypot(edgeX, edgeZ);
      nx = -edgeZ / length; nz = edgeX / length;
      if (polygonContains(polygon, x + nx * 1e-5, z + nz * 1e-5)) { nx = -nx; nz = -nz; }
    }
    contact.nx = nx; contact.nz = nz; contact.depth = radius + (inside ? distance : -distance);
  }
  return true;
}

// Fraction of a ray's clipped interval inside the footprint, used by the low-rate audio probes.
function polygonSegmentFraction(polygon, ax, az, dx, dz, enter, exit) {
  if (exit <= enter) return 0;
  const cuts = [enter, exit];
  for (let r = -1; r < polygon.holes.length; r++) {
    const ring = r < 0 ? polygon.outer : polygon.holes[r];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j], b = ring[i], ex = b.x - a.x, ez = b.z - a.z;
      const cross = dx * ez - dz * ex;
      if (Math.abs(cross) < 1e-10) continue;
      const qx = a.x - ax, qz = a.z - az;
      const t = (qx * ez - qz * ex) / cross, u = (qx * dz - qz * dx) / cross;
      if (t > enter && t < exit && u >= 0 && u <= 1) cuts.push(t);
    }
  }
  cuts.sort((a, b) => a - b);
  let fraction = 0;
  for (let i = 1; i < cuts.length; i++) {
    const t = (cuts[i - 1] + cuts[i]) * 0.5;
    if (polygonContains(polygon, ax + dx * t, az + dz * t)) fraction += cuts[i] - cuts[i - 1];
  }
  return fraction;
}

export { polygonContains, polygonBoxOverlaps, polygonContact, polygonSegmentFraction };
