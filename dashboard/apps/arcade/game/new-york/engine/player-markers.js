// What the other players look like wherever they are drawn: one colour each, the same in the city and on the map.
const COLORS = [0xf05a4f, 0x3fa7f5, 0x4fc97a, 0xf5b83f, 0xb57cf2, 0x2fd0c8, 0xf27cc0, 0x9aa5b1];

export function colorFor(id) {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return COLORS[Math.abs(hash) % COLORS.length];
}

export function cssColor(hex) {
  return `#${hex.toString(16).padStart(6, '0')}`;
}

// Where a player sits on the radar, around its centre: somebody beyond `radius` stays on its rim along the same
// bearing, so the way to them always shows
export function pinToRadar(x, y, radius) {
  const scale = Math.max(1, Math.hypot(x, y) / radius);
  return { x: x / scale, y: y / scale };
}
