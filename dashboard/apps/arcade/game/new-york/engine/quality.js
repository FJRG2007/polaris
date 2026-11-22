// js/quality.js
// Graphics quality: what each level draws, the level the player chose (kept per device), and the one Auto picks.
//   low     no shadows, no reflections, no bloom: the cheapest shaders, for the WebGL2 fallback and weak GPUs
//   medium  sun shadows and bloom, no screen-space reflections
//   high    everything (soft contact-hardening shadows, half-res SSR, half-res AO, light shafts, bloom)
//   ultra   high plus a sharper image (up to 1.5x pixel ratio), a 4096 px shadow atlas and motion blur
// Every level also carries the cost knobs the renderer reads at start-up: the render resolution scale, the shadow
// tile size, the shadow filter, ambient occlusion, light shafts (with their march steps), motion blur and rain density.
// castLights is the share of each fixed cast-light pool (street lamps, shop spots) lit at once; vehicle headlights are
// always lit in full, as in the reference game. Every pool keeps
// its size whatever the level - adding or removing a light recompiles every lit material - so a lower level only
// leaves more of its lights at intensity 0, which the clustered lighting skips.
// Auto starts from what the device says about itself and steps down for the next visit when the game ran slowly.

const SETTING_KEY = 'nyc-quality';
const AUTO_KEY = 'nyc-quality-auto';
const LEVELS = ['low', 'medium', 'high', 'ultra'];
const SETTINGS = ['auto', ...LEVELS];

const PRESETS = {
  low: {
    shadows: false, reflections: false, bloom: false, castLights: 0.375, resolutionScale: 0.8, shadowMapSize: 1024,
    softShadows: false, ao: false, shafts: 0, motionBlur: false, rain: 0.35
  },
  medium: {
    shadows: true, reflections: false, bloom: true, castLights: 0.67, resolutionScale: 1, shadowMapSize: 2048,
    softShadows: false, ao: false, shafts: 16, motionBlur: false, rain: 0.6
  },
  high: {
    shadows: true, reflections: true, bloom: true, castLights: 1, resolutionScale: 1, shadowMapSize: 2048,
    softShadows: true, ao: true, shafts: 32, motionBlur: false, rain: 1
  },
  ultra: {
    shadows: true, reflections: true, bloom: true, castLights: 1, resolutionScale: 1.5, shadowMapSize: 4096,
    softShadows: true, ao: true, shafts: 48, motionBlur: true, rain: 1
  }
};

// The share in use this session; set once from the level (a change of level restarts the city)
let castLightShare = 1;

function setCastLightShare(share) {
  castLightShare = Number.isFinite(share) ? Math.min(Math.max(share, 0), 1) : 1;
}

/** How many lights of a pool may be lit at once: its share, rounded, at least one. */
function lightBudget(pool, share = castLightShare) {
  return Math.min(pool, Math.max(1, Math.round(pool * share)));
}

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

// Classes of graphics chip by the name the browser reports for it. Software rasterizers draw a frame in seconds;
// integrated chips share memory bandwidth with the CPU; the top discrete cards can carry Ultra.
const SOFTWARE_GPU = /swiftshader|llvmpipe|softpipe|software|basic render|microsoft basic/i;
const INTEGRATED_GPU =
  /intel(?!.*\barc\b)|\buhd\b|iris|hd graphics|adreno|mali|powervr|videocore|apple gpu|radeon\(tm\) graphics|radeon graphics|vega \d+ graphics|\bxclipse\b/i;
const TOP_GPU = /rtx\s?(30[6-9]0|40[6-9]0|50\d0)|rx\s?(6[89]\d0|7[89]\d0|9\d{3})|radeon pro w7|apple m\d (pro|max|ultra)/i;

/**
 * The level a chip's reported name points to: 'low' for a software rasterizer, 'medium' for an integrated chip,
 * 'ultra' for the top discrete cards, null when the name says nothing (the other device signals decide).
 */
function gpuQuality(name) {
  if (typeof name !== 'string' || !name.trim()) return null;
  if (SOFTWARE_GPU.test(name)) return 'low';
  if (TOP_GPU.test(name)) return 'ultra';
  if (INTEGRATED_GPU.test(name)) return 'medium';
  return null;
}

/** The chip's name as the browser reports it (WebGPU adapter info, or the WebGL debug renderer string). */
function rendererName(renderer) {
  try {
    const info = renderer.backend.device?.adapterInfo;
    if (info) return [info.vendor, info.architecture, info.device, info.description].filter(Boolean).join(' ');
    const gl = renderer.backend.gl;
    const ext = gl?.getExtension('WEBGL_debug_renderer_info');
    if (gl) return String(gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER) ?? '');
  } catch { /* a browser that hides it */ }
  return '';
}

/** What Auto picks on this device before it has seen the game run. */
function deviceQuality(renderer, name = rendererName(renderer)) {
  const chip = gpuQuality(name);
  // A software rasterizer is low whatever else the device says
  if (chip === 'low') return 'low';
  // The WebGL2 fallback builds every pipeline on the main thread, with no parallel compile worth the name
  if (!renderer.backend.isWebGPUBackend) return 'low';
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const memory = navigator.deviceMemory ?? 8;
  const cores = navigator.hardwareConcurrency ?? 8;
  const maxTexture = renderer.backend.device?.limits?.maxTextureDimension2D ?? 8192;
  if (memory <= 2 || cores <= 2) return 'low';
  if (coarse || memory <= 4 || cores <= 4 || maxTexture < 8192 || chip === 'medium') return 'medium';
  // Ultra only for a chip known to carry it; any other capable desktop starts at High
  return chip === 'ultra' ? 'ultra' : 'high';
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

export {
  LEVELS, PRESETS, SETTINGS, deviceQuality, gpuQuality, learnAutoQuality, lightBudget, readQualitySetting, rendererName,
  resolveQuality, saveQualitySetting, setCastLightShare
};
