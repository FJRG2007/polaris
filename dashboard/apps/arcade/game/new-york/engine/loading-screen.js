// The loading screen: one bar in three steps (the map's download, the city's build, the graphics), the step under
// way with how far the whole load is, and a tip about the controls every few seconds. It is the only one on screen:
// the framing page hides its own as soon as this page reports progress (game-frame.tsx).
//
// Imported first by main.js, so it runs before any module that waits on the city data (nyc-geodata.js).
import { onProgress } from './embed.js';
import { formatNumber, localeReady, onLocaleChange, t } from './i18n.js';

/** Where each step sits on the whole load: the same weights the bar's three segments are drawn with. */
const STAGES = { data: [0, 0.3], build: [0.3, 0.55], compile: [0.55, 1] };
const ORDER = ['data', 'build', 'compile'];
const TIP_MS = 5500;
const KEY_TIPS = ['menu', 'modes', 'map', 'camera', 'boost', 'hud', 'gamepad'];
const TOUCH_TIPS = ['stick', 'look', 'map', 'menu'];

const overlay = document.getElementById('loading-overlay');
const bar = document.getElementById('loading-bar');
const stageText = document.getElementById('loading-stage');
const percentText = document.getElementById('loading-percent');
const tipText = document.getElementById('loading-tip');
const steps = Object.fromEntries(ORDER.map((stage) => [stage, overlay?.querySelector(`[data-stage="${stage}"]`)]));

const done = { data: 0, build: 0, compile: 0 };
let current = 'data';
let tipIndex = 0;
let tipTimer = 0;
const touch = matchMedia('(pointer: coarse)').matches;
const tips = touch ? TOUCH_TIPS.map((id) => `loading.touchTips.${id}`) : KEY_TIPS.map((id) => `loading.tips.${id}`);

function total() {
  return ORDER.reduce((sum, stage) => sum + (STAGES[stage][1] - STAGES[stage][0]) * done[stage], 0);
}

function draw() {
  if (!overlay) return;
  for (const stage of ORDER) {
    const step = steps[stage];
    if (!step) continue;
    step.querySelector('.loader-fill').style.transform = `scaleX(${done[stage]})`;
    step.classList.toggle('is-done', done[stage] >= 1);
    step.classList.toggle('is-current', stage === current && done[stage] < 1);
  }
  const share = total();
  if (stageText) stageText.textContent = t(`loading.stage.${current}`);
  if (percentText) percentText.textContent = formatNumber(Math.floor(share * 100) / 100, { style: 'percent' });
  bar?.setAttribute('aria-valuenow', String(Math.round(share * 100)));
  bar?.setAttribute('aria-valuetext', `${t(`loading.stage.${current}`)} ${percentText?.textContent || ''}`);
}

function showTip() {
  if (tipText) tipText.textContent = t(tips[tipIndex % tips.length]);
}

onProgress((stage, share) => {
  if (!Object.hasOwn(done, stage)) return;
  // Steps run in order: reaching one completes the ones before it
  for (const earlier of ORDER.slice(0, ORDER.indexOf(stage))) done[earlier] = 1;
  done[stage] = Math.max(done[stage], share);
  current = done[stage] >= 1 && stage !== 'compile' ? ORDER[ORDER.indexOf(stage) + 1] : stage;
  draw();
});

onLocaleChange(() => {
  draw();
  showTip();
});

// The words wait for the reader's catalog, so they never flash in another language; the bar does not
localeReady.then(() => {
  draw();
  showTip();
  overlay?.classList.remove('is-pending');
  tipTimer = setInterval(() => {
    tipIndex++;
    showTip();
  }, TIP_MS);
});

/** Moves the bar to a step (one with no progress of its own to report yet). */
export function enterStage(stage) {
  if (!Object.hasOwn(done, stage)) return;
  for (const earlier of ORDER.slice(0, ORDER.indexOf(stage))) done[earlier] = 1;
  current = stage;
  draw();
}

export function hideLoadingScreen() {
  for (const stage of ORDER) done[stage] = 1;
  draw();
  clearInterval(tipTimer);
  overlay?.classList.add('hidden');
}
