// Planar rigid-body contacts. Bodies use world velocity and a heading basis (sin, cos);
// contact normals point from b to a. Callers reuse bodies and the contact record.
function vehicleContact(a, b, contact) {
  const dx = a.x - b.x, dz = a.z - b.z;
  let depth = Infinity, nx = 0, nz = 0, reference = a, side = 0;
  for (let axis = 0; axis < 4; axis++) {
    const body = axis < 2 ? a : b;
    const ax = axis % 2 === 0 ? body.cos : body.sin;
    const az = axis % 2 === 0 ? -body.sin : body.cos;
    const separation = dx * ax + dz * az;
    const overlap = a.halfW * Math.abs(ax * a.cos - az * a.sin)
      + a.halfL * Math.abs(ax * a.sin + az * a.cos)
      + b.halfW * Math.abs(ax * b.cos - az * b.sin)
      + b.halfL * Math.abs(ax * b.sin + az * b.cos) - Math.abs(separation);
    if (overlap <= 0) return false;
    if (overlap < depth) {
      depth = overlap;
      const sign = separation >= 0 ? 1 : -1;
      nx = ax * sign; nz = az * sign;
      reference = body;
      side = axis % 2;
    }
  }

  // Clip the incident face to the reference face. Averaging the surviving segment
  // gives centered bumper hits no torque, and offset hits the correct lever arm.
  const incident = reference === a ? b : a;
  const sign = reference === a ? -1 : 1;
  const rx = nx * sign, rz = nz * sign;
  const tx = rz, tz = -rx;
  const extent = side === 0 ? reference.halfW : reference.halfL;
  const halfSide = side === 0 ? reference.halfL : reference.halfW;
  const faceX = reference.x + rx * extent, faceZ = reference.z + rz * extent;
  const across = rx * incident.cos - rz * incident.sin;
  const along = rx * incident.sin + rz * incident.cos;
  const widthFace = Math.abs(across) > Math.abs(along);
  const faceSign = (widthFace ? across : along) >= 0 ? -1 : 1;
  const ix = widthFace ? incident.cos : incident.sin;
  const iz = widthFace ? -incident.sin : incident.cos;
  const itx = widthFace ? incident.sin : incident.cos;
  const itz = widthFace ? incident.cos : -incident.sin;
  const ie = widthFace ? incident.halfW : incident.halfL;
  const length = widthFace ? incident.halfL : incident.halfW;
  const cx = incident.x + ix * ie * faceSign, cz = incident.z + iz * ie * faceSign;
  let lo = -length, hi = length;
  const centerT = (cx - faceX) * tx + (cz - faceZ) * tz;
  const directionT = itx * tx + itz * tz;
  if (Math.abs(directionT) > 1e-8) {
    const first = (-halfSide - centerT) / directionT;
    const last = (halfSide - centerT) / directionT;
    lo = Math.max(lo, Math.min(first, last));
    hi = Math.min(hi, Math.max(first, last));
  }
  const centerN = (cx - faceX) * rx + (cz - faceZ) * rz;
  const directionN = itx * rx + itz * rz;
  if (directionN > 1e-8) hi = Math.min(hi, -centerN / directionN);
  else if (directionN < -1e-8) lo = Math.max(lo, -centerN / directionN);
  const midpoint = (lo + hi) * 0.5;
  const planeDistance = Math.min(0, centerN + midpoint * directionN);
  contact.x = cx + itx * midpoint - rx * planeDistance * 0.5;
  contact.z = cz + itz * midpoint - rz * planeDistance * 0.5;
  contact.nx = nx;
  contact.nz = nz;
  contact.depth = depth;
  contact.ax = a.x; contact.az = a.z;
  contact.bx = b.x; contact.bz = b.z;
  return true;
}

function resolveVehicleContact(a, b, contact) {
  const { x, z, nx, nz } = contact;
  const ax = x - a.x, az = z - a.z, bx = x - b.x, bz = z - b.z;
  const inverseA = a.mass > 0 ? 1 / a.mass : 0;
  const inverseB = b.mass > 0 ? 1 / b.mass : 0;
  const inertiaA = 3 * inverseA / (a.halfW * a.halfW + a.halfL * a.halfL);
  const inertiaB = 3 * inverseB / (b.halfW * b.halfW + b.halfL * b.halfL);
  const normalA = az * nx - ax * nz, normalB = bz * nx - bx * nz;
  let vx = a.vx + a.angularVel * az - b.vx - b.angularVel * bz;
  let vz = a.vz - a.angularVel * ax - b.vz + b.angularVel * bx;
  const closing = -(vx * nx + vz * nz);
  contact.impulse = 0;
  if (closing <= 0 || inverseA + inverseB === 0) return 0;

  const restitution = closing > 1 ? 0.08 : 0;
  const impulse = (1 + restitution) * closing
    / (inverseA + inverseB + normalA * normalA * inertiaA + normalB * normalB * inertiaB);
  a.vx += nx * impulse * inverseA;
  a.vz += nz * impulse * inverseA;
  a.angularVel += normalA * impulse * inertiaA;
  b.vx -= nx * impulse * inverseB;
  b.vz -= nz * impulse * inverseB;
  b.angularVel -= normalB * impulse * inertiaB;

  // Sliding panels lose tangential motion, bounded by the normal impact force.
  const tx = nz, tz = -nx;
  const tangentA = az * tx - ax * tz, tangentB = bz * tx - bx * tz;
  vx = a.vx + a.angularVel * az - b.vx - b.angularVel * bz;
  vz = a.vz - a.angularVel * ax - b.vz + b.angularVel * bx;
  const tangentImpulse = -(vx * tx + vz * tz)
    / (inverseA + inverseB + tangentA * tangentA * inertiaA + tangentB * tangentB * inertiaB);
  const friction = Math.max(-impulse * 0.35, Math.min(impulse * 0.35, tangentImpulse));
  a.vx += tx * friction * inverseA;
  a.vz += tz * friction * inverseA;
  a.angularVel += tangentA * friction * inertiaA;
  b.vx -= tx * friction * inverseB;
  b.vz -= tz * friction * inverseB;
  b.angularVel -= tangentB * friction * inertiaB;
  contact.impulse = impulse;
  return closing;
}

// Continuous SAT for fast contacts missed between frames. Rotation uses this
// frame's headings; successful sweeps move the temporary bodies to impact time.
function sweptVehicleContact(a, b, contact) {
  const adx = a.x - a.prevX, adz = a.z - a.prevZ;
  const bdx = b.x - b.prevX, bdz = b.z - b.prevZ;
  const dx = a.prevX - b.prevX, dz = a.prevZ - b.prevZ;
  const vx = adx - bdx, vz = adz - bdz;
  let enter = 0, leave = 1, initiallyOverlapping = true;
  for (let axis = 0; axis < 4; axis++) {
    const body = axis < 2 ? a : b;
    const ax = axis % 2 === 0 ? body.cos : body.sin;
    const az = axis % 2 === 0 ? -body.sin : body.cos;
    const extent = a.halfW * Math.abs(ax * a.cos - az * a.sin)
      + a.halfL * Math.abs(ax * a.sin + az * a.cos)
      + b.halfW * Math.abs(ax * b.cos - az * b.sin)
      + b.halfL * Math.abs(ax * b.sin + az * b.cos);
    const start = dx * ax + dz * az, velocity = vx * ax + vz * az;
    if (Math.abs(start) >= extent) initiallyOverlapping = false;
    if (Math.abs(velocity) < 1e-8) {
      if (Math.abs(start) >= extent) return false;
      continue;
    }
    const first = (-extent - start) / velocity, last = (extent - start) / velocity;
    enter = Math.max(enter, Math.min(first, last));
    leave = Math.min(leave, Math.max(first, last));
    if (enter >= leave) return false;
  }
  if (initiallyOverlapping) return false;
  // A tiny inset lets the same clipped-face routine find the contact point.
  const time = Math.min((enter + leave) * 0.5, enter + 1e-5);
  const ax = a.x, az = a.z, bx = b.x, bz = b.z;
  a.x = a.prevX + adx * time; a.z = a.prevZ + adz * time;
  b.x = b.prevX + bdx * time; b.z = b.prevZ + bdz * time;
  if (vehicleContact(a, b, contact)) {
    // Keep the frame's tangential motion and center-of-mass travel. Only the
    // relative normal movement after contact is blocked; rewinding both cars
    // completely would stop touching vehicles that are still moving together.
    const remaining = (ax - a.x - bx + b.x) * contact.nx + (az - a.z - bz + b.z) * contact.nz;
    const inverseA = a.mass > 0 ? 1 / a.mass : 0, inverseB = b.mass > 0 ? 1 / b.mass : 0;
    const share = inverseA / (inverseA + inverseB || 1);
    contact.ax = ax - contact.nx * remaining * share;
    contact.az = az - contact.nz * remaining * share;
    contact.bx = bx + contact.nx * remaining * (1 - share);
    contact.bz = bz + contact.nz * remaining * (1 - share);
    return true;
  }
  a.x = ax; a.z = az; b.x = bx; b.z = bz;
  return false;
}

export { vehicleContact, resolveVehicleContact, sweptVehicleContact };
