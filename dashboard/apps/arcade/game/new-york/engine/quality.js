// js/quality.js
// Graphics quality: what each level draws, the level the player chose (kept per device), and the one Auto picks.
//   low     no shadows, no reflections, no bloom: the cheapest shaders, for the WebGL2 fallback and weak GPUs
//   medium  sun shadows and bloom, no screen-space reflections
//   high    everything (shadows, half-res SSR, bloom)
// Auto starts from what the device says about itself and steps down for the next visit when the game ran slowly.

const SETTING_KEY = 'nyc-quality';
const AUTO_KEY = 'nyc-quality-auto';
const LEVELS = ['low', 'medium', 'high'];
const SETTINGS = ['auto', ...LEVELS];

const PRESETS = {
  low: { shadows: false, reflections: false, bloom: false },
  medium: { shadows: true, reflections: false, bloom: true },
  high: { shadows: true, reflections: true, bloom: true }
};

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null; // storage disabled: Auto every time
  }
}

function writeStorage(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* storage disabled or full */ }
}

/** The player's choice: `?quality=` on the page address first (for testing), then the saved one, else Auto. */
function readQualitySetting() {
  const fromUrl = new URLSearchParams(location.search).get('quality');
  if (SETTINGS.includes(fromUrl)) return fromUrl;
  const saved = readStorage(SETTING_KEY);
  return SETTINGS.includes(saved) ? saved : 'auto';
}

function saveQualitySetting(setting) {
  if (SETTINGS.includes(setting)) writeStorage(SETTING_KEY, setting);
}

/** What Auto picks on this device before it has seen the game run. */
function deviceQuality(renderer) {
  // The WebGL2 fallback builds every pipeline on the main thread, with no parallel compile worth the name
  if (!renderer.backend.isWebGPUBackend) return 'low';
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const memory = navigator.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const maxTexture = renderer.backend.device?.limits?.maxTextureDimension2D ?? 8192;
  if (memory <= 2 || cores <= 2) return 'low';
  if (coarse || memory <= 4 || cores <= 4 || maxTexture < 8192) return 'medium';
  return 'high';
}

/** The level to draw at for a setting: Auto takes the device's level, or the lower one an earlier visit settled on. */
function resolveQuality(setting, renderer) {
  if (LEVELS.includes(setting)) return setting;
  const device = deviceQuality(renderer);
  const learned = readStorage(AUTO_KEY);
  if (LEVELS.includes(learned) && LEVELS.indexOf(learned) < LEVELS.indexOf(device)) return learned;
  return device;
}

/**
 * Auto only: after the game has run for a while, a frame rate under 30 steps the next visit down a level
 * (and one well above 55 at a level Auto lowered earlier lets it try the next one up again).
 */
function learnAutoQuality(level, fps) {
  if (!Number.isFinite(fps)) return;
  const index = LEVELS.indexOf(level);
  if (fps < 30 && index > 0) writeStorage(AUTO_KEY, LEVELS[index - 1]);
  else if (fps > 55 && readStorage(AUTO_KEY) === level && index < LEVELS.length - 1) writeStorage(AUTO_KEY, LEVELS[index + 1]);
}

export { LEVELS, PRESETS, SETTINGS, learnAutoQuality, readQualitySetting, resolveQuality, saveQualitySetting };
