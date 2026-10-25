import * as THREE from 'three/webgpu';
import { pass, mrt, output, normalView, positionView, metalness, roughness, vec2, vec4, smoothstep } from 'three/tsl';
import { ssr } from 'three/addons/tsl/display/SSRNode.js';
import { createPostProcessing } from './post-processing.js';
import { ClusteredSpotLighting } from './clustered-lights.js';
import { drawOnlyCompiled } from './async-pipelines.js';
import { PRESETS, learnAutoQuality, readQualitySetting, resolveQuality, saveQualitySetting } from './quality.js';
import { getLocationLabel, isTypingInField, ROADS, NYC_LANDMARKS, TELEPORT_LOCATIONS } from './city-config.js';
import { buildCityGrid } from './city-grid.js';
import { buildBoroughs } from './boroughs.js';
import { buildLandmarks } from './landmarks.js';
import { buildCityBlocks } from './buildings.js';
import { buildStreetDetails } from './street-details.js';
import { createTrafficSystem, createHighwayTraffic } from './traffic.js';
import { buildRoadPaint } from './road-paint.js';
import { ThirdPersonControllerManager } from './controllers.js';
import { TouchControls } from './touch-controls.js';
import { GamepadControls } from './gamepad-controls.js';
import { CameraSystem, CAMERA_PRESETS } from './cameras.js';
import { LightingSystem } from './lighting.js';
import { NYCMapSystem } from './nyc-map.js';
import { setupSceneCulling, updateSceneCulling } from './scene-culling.js';
import { CityAudioSystem } from './audio-system.js';
import { createRemotePlayers } from './remote-players.js';
import { reportFailure, reportProgress, reportReady, shareState } from './embed.js';

// js/main.js
// Main entry point for New York City (Midtown Manhattan) in Three.js WebGPURenderer & TSL (three.js, bundled by the app build)

// The start-up phases the host's progress bar counts while the city is built (`markInit` labels)
// Milliseconds of pipeline building per frame (async-pipelines.js): behind the loading screen, then while playing
const LOADING_BUILD_BUDGET = 45;
const PLAYING_BUILD_BUDGET = 6;

const BUILD_STEPS = ['renderer', 'lighting', 'cityGrid', 'boroughs', 'landmarks', 'blocks', 'streetDetails', 'traffic', 'roadPaint', 'controllers', 'culling', 'ui', 'postFX'];

async function initApp() {
  const container = document.getElementById('canvas-container');
  const loadingOverlay = document.getElementById('loading-overlay');
  const loadingStatus = document.getElementById('loading-status');
  const loadingTrack = loadingOverlay ? loadingOverlay.querySelector('.loader-track') : null;
  const loadingFill = document.getElementById('loading-progress');
  // The loading bar sweeps while the city is being built (the main thread is busy) and fills as the shaders compile
  const setLoadingProgress = (p) => {
    if (!loadingFill) return;
    if (loadingTrack) loadingTrack.classList.remove('is-indeterminate');
    loadingFill.style.transform = `scaleX(${Math.min(1, Math.max(0, p))})`;
  };

  if (loadingStatus) {
    loadingStatus.textContent = `Initializing Three.js r${THREE.REVISION} WebGPURenderer & TSL Shaders...`;
  }

  // 1. Initialize Three.js WebGPURenderer with 32-bit float reversedDepthBuffer
  const renderer = new THREE.WebGPURenderer({
    antialias: true,
    powerPreference: 'high-performance',
    reversedDepthBuffer: true
  });
  renderer.setPixelRatio(1.0);
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.shadowMap.enabled = true;
  // Point and spot lights alike are clustered (clustered-lights.js): no lit shader unrolls the city's light pools
  renderer.lighting = new ClusteredSpotLighting(256, 32, 28, 48);
  container.appendChild(renderer.domElement);

  // Start-up phase timings (logged once as "[init] ...") to keep load-time regressions traceable
  let initTimings = [];
  let initMark = performance.now();
  const markInit = (label) => {
    const now = performance.now();
    if (initTimings) initTimings.push(`${label} ${Math.round(now - initMark)}ms`);
    performance.mark(`init:${label}`);
    initMark = now;
    const step = BUILD_STEPS.indexOf(label);
    if (step >= 0) reportProgress('build', (step + 1) / BUILD_STEPS.length);
  };
  // Hands the main thread back between start-up phases: the game shares it with the page that frames it, so without
  // this the whole tab (and the host's progress bar) froze until the city was built
  const nextTask = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise((resolve) => setTimeout(resolve, 0)));
  // (a plain task, not scheduler.yield(), whose continuation would run ahead of the host's progress messages)
  const stepDone = (label) => {
    markInit(label);
    return new Promise((resolve) => setTimeout(resolve, 0));
  };

  try {
    await renderer.init();
  } catch (e) {
    reportFailure('graphics');
    throw e;
  }
  // From here on a draw whose pipeline is not built yet waits for it instead of stalling the frame (async-pipelines.js)
  const viewPosition = new THREE.Vector3();
  const pipelineGate = drawOnlyCompiled(renderer, { near: () => viewPosition });
  pipelineGate.setBudget(LOADING_BUILD_BUDGET);
  const qualitySetting = readQualitySetting();
  const quality = resolveQuality(qualitySetting, renderer);
  const preset = PRESETS[quality];
  renderer.shadowMap.enabled = preset.shadows;
  console.log(`[init] quality ${quality} (${qualitySetting}), ${renderer.backend.isWebGPUBackend ? 'WebGPU' : 'WebGL2'}`);
  await stepDone('renderer');

  // 2. Build Scene & Physical Atmospheric Sky / PMREM IBL / 4096x4096 Shadow Lighting
  const scene = new THREE.Scene();
  const lightingSystem = new LightingSystem(scene, renderer);
  lightingSystem.sunLight.castShadow = preset.shadows;
  await stepDone('lighting');

  if (loadingStatus) {
    loadingStatus.textContent = 'Constructing Manhattan Grid, Landmarks & Streetscape...';
  }

  // 3. Build Manhattan Geography, Iconic Landmarks, Blocks, Street Details & Traffic
  const cityGrid = buildCityGrid(scene);
  await stepDone('cityGrid');
  const boroughs = buildBoroughs(scene, { sidewalks: cityGrid.sidewalks });
  await stepDone('boroughs');
  const { colliders: landmarkColliders } = buildLandmarks(scene);
  await stepDone('landmarks');
  const cityBlocks = buildCityBlocks(scene);
  await stepDone('blocks');
  const allColliders = [...landmarkColliders, ...cityBlocks.colliders, ...boroughs.colliders, ...(cityGrid.colliders || [])];

  const streetDetails = buildStreetDetails(scene);
  await stepDone('streetDetails');
  // Buildings turned along non-grid streets have oriented colliders whose world bounds reach past their lots: they stay
  // inside the property line anyway, so the road network (lanes & sidewalks) doesn't need them.
  // Elevated building sections that clear even a bus don't obstruct ground traffic.
  const trafficSystem = createTrafficSystem(scene, cityGrid.sidewalks, [
    ...cityGrid.footprints,
    ...streetDetails.footprints,
    ...allColliders.filter((c) => !c.obb && (c.minY ?? 0) < 3.5)
  ]);
  await stepDone('traffic');
  const highwayTraffic = createHighwayTraffic(scene, cityGrid.highwayLanes);
  buildRoadPaint(scene, trafficSystem.network);
  await stepDone('roadPaint');

  // 4. Initialize Third-Person Controllers (Person, Car, Cyclist, Helicopter) & Multi-Camera System
  const controllerManager = new ThirdPersonControllerManager(scene, allColliders);
  // Reuse teleport placement so saved players return at rest, close to their last positions.
  try {
    const saved = JSON.parse(localStorage.getItem('nyc-player-state'));
    if (saved?.version === 1) {
      for (const mode of Object.keys(controllerManager.entities)) {
        const p = saved.entities?.[mode];
        if (!p || ![p.x, p.y, p.z, p.heading].every(Number.isFinite)) continue;
        controllerManager.setMode(mode);
        controllerManager.teleportActiveTo(p.x, p.z, p.heading, p.y);
      }
      controllerManager.setMode(Object.hasOwn(controllerManager.entities, saved.activeMode) ? saved.activeMode : 'car');
    }
  } catch { /* Missing or unavailable storage does not prevent playing. */ }

  function savePlayerState() {
    try {
      const entities = Object.fromEntries(Object.entries(controllerManager.entities).map(([mode, entity]) => [mode, {
        x: entity.position.x, y: entity.position.y, z: entity.position.z, heading: entity.heading
      }]));
      localStorage.setItem('nyc-player-state', JSON.stringify({ version: 1, activeMode: controllerManager.activeMode, entities }));
    } catch { /* Storage may be disabled or full. */ }
  }

  const cameraSystem = new CameraSystem(renderer.domElement, controllerManager);
  const remotePlayers = createRemotePlayers(scene);
  const touchControls = new TouchControls(controllerManager);
  const soundButton = document.getElementById('btn-sound');
  const audioSystem = new CityAudioSystem({ controllerManager, trafficSystem, highwayTraffic, streetDetails }, {
    onStateChange: updateSoundButton
  });
  function updateSoundButton() {
    if (!soundButton) return;
    soundButton.disabled = !audioSystem.supported;
    soundButton.setAttribute('aria-pressed', String(audioSystem.enabled));
    soundButton.setAttribute('aria-label', audioSystem.enabled ? 'Mute sound' : 'Enable sound');
    soundButton.title = audioSystem.supported ? `${audioSystem.enabled ? 'Mute' : 'Enable'} sound [N]` : 'Web Audio is unavailable';
    soundButton.querySelector('use').setAttribute('href', audioSystem.enabled ? '#i-sound' : '#i-sound-off');
  }
  soundButton?.addEventListener('click', () => audioSystem.setEnabled(!audioSystem.enabled));
  updateSoundButton();
  // pagehide also covers navigation away on mobile; preserve the context across back-forward cache restores.
  window.addEventListener('pagehide', (event) => {
    savePlayerState();
    if (!event.persisted) audioSystem.dispose();
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePlayerState(); });
  await stepDone('controllers');

  // Island-wide static geometry: chunk & distance-cull the small props, shadow stand-ins for the big casters
  // (scene-culling.js)
  const cullingRoots = ['ManhattanCityGrid', 'ManhattanCityBlocks', 'ManhattanStreetDetails', 'ManhattanLandmarks', 'Boroughs']
    .map((name) => scene.getObjectByName(name))
    .filter(Boolean);
  setupSceneCulling(scene, cullingRoots, lightingSystem.sunLight.shadow);
  await stepDone('culling');

  // On WebGPU, small InstancedMeshes (<= 1000 instances) keep their matrices in uniform buffers that three.js
  // re-uploads on every draw of every pass (~2.5 MB/frame with the shadow cascades, stalling the GPU queue).
  // Storage attributes only upload when needed; WebGL2 needs ordinary instanced attributes for correct transforms.
  if (renderer.backend.isWebGPUBackend) {
    scene.traverse((object) => {
      if (object.isInstancedMesh) {
        object.instanceMatrix = new THREE.StorageInstancedBufferAttribute(object.instanceMatrix.array, 16);
      }
    });
  }

  // 5. TSL RenderPipeline with Half-Res Screen Space Reflections (SSRNode), Bloom & Filmic Toning
  //    Fade out distant and matte surfaces so SSR spends its rays on visible glossy reflections.
  const scenePass = pass(scene, cameraSystem.camera);
  // The multisampled colour attachments (output, normal, metalRough) only need resolving, never storing: discarding
  // them spares the GPU writing 3 x 4 samples per pixel to memory every frame (transient, memoryless attachments where
  // the browser supports them). The multisampled depth stays stored: SSR reads it.
  scenePass.renderTarget.storeMultisampledColorBuffer = false;
  // The reflections (High) need the scene's normals and roughness as well: the other levels draw colour alone
  const scenePassColor = scenePass.getTextureNode('output');
  let sceneMRT = null;
  let reflections = vec4(0);
  if (preset.reflections) {
    const ssrFade = smoothstep(360.0, 180.0, positionView.z.negate());
    const maxSSRRoughness = 0.75;
    sceneMRT = mrt({
      output: output,
      normal: normalView,
      metalRough: vec2(roughness.lessThan(maxSSRRoughness).select(metalness.mul(ssrFade), 0), roughness)
    });
    sceneMRT.setBlendMode('normal', new THREE.BlendMode(THREE.MaterialBlending));
    sceneMRT.setBlendMode('metalRough', new THREE.BlendMode(THREE.MaterialBlending));
    scenePass.setMRT(sceneMRT);

    const scenePassDepth = scenePass.getTextureNode('depth');
    const scenePassNormal = scenePass.getTextureNode('normal');
    const scenePassMetalRough = scenePass.getTextureNode('metalRough');

    const ssrPass = ssr(scenePassColor, scenePassDepth, scenePassNormal, {
      metalnessNode: scenePassMetalRough.r,
      roughnessNode: scenePassMetalRough.g,
      camera: cameraSystem.camera
    });
    ssrPass.resolutionScale = 0.5;
    ssrPass.blurQuality = 1;
    ssrPass.maxDistance.value = 42;
    ssrPass.thickness.value = 0.85;
    // Fewer coarse steps, then refine detected hits to keep reflection edges precise.
    ssrPass.quality.value = 0.25;
    ssrPass.binaryRefine = true;
    ssrPass.intensity.value = 0.50;
    ssrPass.screenEdgeFadeBlack = true;

    // Roughness mip blur must not spread reflections back onto matte or nonreflective surfaces.
    const reflectionMask = scenePassMetalRough.r.greaterThan(0).select(smoothstep(maxSSRRoughness, 0.55, scenePassMetalRough.g), 0);
    reflections = ssrPass.mul(reflectionMask);
  } else {
    // Without reflections the pass draws colour alone, but the decal, lamp-pool and flare materials still carry an MRT
    // of their own (normal, metalRough). Without a scene MRT three would use it in place of the colour output, find
    // none of its targets in the pass and emit an empty WGSL output struct, so those pipelines failed to compile.
    // Merged into this one, their colour is kept and the targets the pass does not have are dropped.
    scenePass.setMRT(mrt({ output }));
  }
  const colorGrade = createPostProcessing(renderer, scenePassColor, reflections, { bloom: preset.bloom });
  const renderPipeline = new THREE.RenderPipeline(renderer, colorGrade.outputNode);

  // 6. Wire UI Controls (Strictly using safe DOM APIs: textContent, classList, addEventListener)
  const modeButtons = document.querySelectorAll('[data-mode]');
  const cameraButtons = document.querySelectorAll('[data-camera]');
  const timeButtons = document.querySelectorAll('[data-time]');
  const teleportButtons = document.querySelectorAll('[data-teleport]');
  const hudToggleBtn = document.getElementById('btn-toggle-hud');
  const modeSwitch = document.getElementById('mode-switch');
  touchControls.onAvailabilityChange = placeModeIndicator;

  const elFps = document.getElementById('hud-fps');
  const elMode = document.getElementById('hud-active-mode');
  const elCamera = document.getElementById('hud-active-camera');
  const elSpeed = document.getElementById('hud-speed');
  const elSpeedMeter = document.getElementById('hud-speed-meter');
  const elAltitude = document.getElementById('hud-altitude');
  const elLocation = document.getElementById('hud-location');
  const elControlsHint = document.getElementById('hud-controls-hint');
  const gamepadControls = new GamepadControls(controllerManager, cameraSystem, {
    onCycleMode: (step) => {
      const modes = ['person', 'car', 'cyclist', 'helicopter'];
      selectMode(modes[(modes.indexOf(controllerManager.activeMode) + step + modes.length) % modes.length]);
    },
    onCycleCamera: cycleCamera,
    onToggleMap: () => mapSystem.toggleFullMap(!mapSystem.isFullMapOpen),
    onCloseMap: () => mapSystem.toggleFullMap(false)
  });

  // Keyboard guide for each mode: [keys, action]
  const controlHints = {
    person: [[['W', 'S'], 'Walk'], [['A', 'D'], 'Turn'], [['Shift'], 'Sprint'], [['Space'], 'Jump'], [['Drag'], 'Orbit']],
    car: [[['W', 'S'], 'Drive / Reverse'], [['A', 'D'], 'Steer'], [['Shift'], 'Boost'], [['B'], 'Horn'], [['Drag'], 'Orbit']],
    cyclist: [[['W', 'S'], 'Pedal / Brake'], [['A', 'D'], 'Lean & Turn'], [['Shift'], 'Sprint'], [['Drag'], 'Orbit']],
    helicopter: [[['W', 'S'], 'Pitch'], [['A', 'D'], 'Yaw'], [['Space', 'E'], 'Ascend'], [['Q', 'C'], 'Descend'], [['Shift'], 'Boost']]
  };
  // Boosted top speeds in mph (controllers.js caps them at 8.2, 36, 19 & 52 m/s): full scale of the speed meter
  const topSpeedMph = { person: 18, car: 81, cyclist: 43, helicopter: 116 };

  function renderControlHints(mode) {
    if (!elControlsHint) return;
    const items = (controlHints[mode] || []).map(([keys, action]) => {
      const item = document.createElement('span');
      item.className = 'hint';
      for (const key of keys) {
        const kbd = document.createElement('kbd');
        kbd.textContent = key;
        item.appendChild(kbd);
      }
      const label = document.createElement('span');
      label.className = 'hint-label';
      label.textContent = action;
      item.appendChild(label);
      return item;
    });
    elControlsHint.replaceChildren(...items);
  }

  // The taxi-yellow pill under the selected mode glides from button to button
  function placeModeIndicator() {
    const active = modeSwitch ? modeSwitch.querySelector('.mode-btn.active') : null;
    if (!active) return;
    modeSwitch.style.setProperty('--ind-x', `${active.offsetLeft}px`);
    modeSwitch.style.setProperty('--ind-w', `${active.offsetWidth}px`);
  }

  function selectMode(mode) {
    controllerManager.setMode(mode);
    touchControls.setMode(controllerManager.activeMode);
    gamepadControls.reset();
    modeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-mode') === mode);
    });
    document.body.dataset.mode = mode;
    placeModeIndicator();
    const ent = controllerManager.getActiveEntity();
    if (elMode) elMode.textContent = ent.label;
    renderControlHints(mode);

    // If currently on a static scenic camera, switch to 3rd-Person Chase so user sees their selected character/vehicle
    const currentCam = cameraSystem.getActivePreset();
    if (currentCam.category !== 'follow') {
      selectCamera('chase', false);
    }
  }

  function selectCamera(camId, snap = false) {
    cameraSystem.setCameraPreset(camId, snap);
    cameraButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-camera') === camId);
    });
    const preset = cameraSystem.getActivePreset();
    if (elCamera) elCamera.textContent = preset.name;
  }

  // Steps through CAMERA_PRESETS (V / Shift+V, and the arrows either side of the camera name)
  function cycleCamera(step) {
    const n = CAMERA_PRESETS.length;
    const idx = CAMERA_PRESETS.findIndex((p) => p.id === cameraSystem.activePresetId);
    selectCamera(CAMERA_PRESETS[(idx + step + n) % n].id, true);
  }

  function selectTime(timeId) {
    lightingSystem.applyPreset(timeId);
    colorGrade.applyPreset(lightingSystem.activePresetId);
    timeButtons.forEach((btn) => {
      btn.classList.toggle('active', btn.getAttribute('data-time') === timeId);
    });
  }

  // Popovers (native [popover]: light dismiss & Esc for free) open against the control that toggles them: data-anchor
  // names the element they sit above / below, data-align the one whose right edge they line up with
  const popovers = document.querySelectorAll('.popover[popover]');
  const supportsPopover = typeof HTMLElement.prototype.togglePopover === 'function';
  function closePopovers() {
    if (!supportsPopover) return;
    popovers.forEach((pop) => {
      if (pop.matches(':popover-open')) pop.hidePopover();
    });
  }
  popovers.forEach((pop) => {
    const invoker = document.querySelector(`[popovertarget="${pop.id}"]`);
    pop.addEventListener('beforetoggle', (e) => {
      const open = e.newState === 'open';
      if (invoker) invoker.classList.toggle('is-open', open);
      if (!open) return;
      const anchor = document.getElementById(pop.dataset.anchor) || invoker;
      const align = document.getElementById(pop.dataset.align) || invoker;
      if (!anchor || !align) return;
      const r = anchor.getBoundingClientRect();
      const spaceAbove = Math.max(0, r.top - 20);
      const spaceBelow = Math.max(0, window.innerHeight - r.bottom - 20);
      let above = pop.dataset.side === 'above';
      // The camera control moves to the top on touch screens; open toward the available space.
      if ((above ? spaceAbove : spaceBelow) < 160) above = spaceAbove > spaceBelow;
      pop.style.right = `${Math.max(8, window.innerWidth - align.getBoundingClientRect().right)}px`;
      if (above) {
        pop.style.top = 'auto';
        pop.style.bottom = `${window.innerHeight - r.top + 8}px`;
        pop.style.maxHeight = `${spaceAbove}px`;
      } else {
        pop.style.bottom = 'auto';
        pop.style.top = `${r.bottom + 8}px`;
        pop.style.maxHeight = `${spaceBelow}px`;
      }
    });
  });

  modeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectMode(btn.getAttribute('data-mode'));
    });
  });

  cameraButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectCamera(btn.getAttribute('data-camera'), true);
      closePopovers();
    });
  });

  const camPrevBtn = document.getElementById('cam-prev');
  const camNextBtn = document.getElementById('cam-next');
  if (camPrevBtn) camPrevBtn.addEventListener('click', () => cycleCamera(-1));
  if (camNextBtn) camNextBtn.addEventListener('click', () => cycleCamera(1));

  timeButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      selectTime(btn.getAttribute('data-time'));
    });
  });

  // Graphics quality: the chosen level is saved for this device and the city restarts at it (every shader depends on
  // it). Auto shows the level it picked.
  const qualityNames = { low: 'Low', medium: 'Medium', high: 'High' };
  const qualityButtons = document.querySelectorAll('[data-quality]');
  const qualityAutoSub = document.getElementById('quality-auto-sub');
  if (qualityAutoSub && qualitySetting === 'auto') qualityAutoSub.textContent = `${qualityNames[quality]} on this device`;
  qualityButtons.forEach((btn) => {
    const value = btn.getAttribute('data-quality');
    btn.classList.toggle('active', value === qualitySetting);
    btn.setAttribute('aria-pressed', String(value === qualitySetting));
    btn.addEventListener('click', () => {
      closePopovers();
      if (value === qualitySetting) return;
      saveQualitySetting(value);
      savePlayerState();
      const url = new URL(location.href);
      url.searchParams.delete('quality');
      location.replace(url.href);
    });
  });

  // A mouse click mustn't leave the focus on a HUD button, or Space (jump / ascend) and Enter would press it again
  document.addEventListener('click', (e) => {
    const btn = e.target instanceof Element ? e.target.closest('button') : null;
    if (btn && e.detail > 0) btn.blur();
  });

  // Where you are: the place's name over its street corner, drawn as a pair of NYC street-name signs
  const roadNames = new Set(ROADS.map((r) => r.name));
  const placeNames = new Set(NYC_LANDMARKS.map((l) => l.name));
  let locationText = '';
  function renderLocation(label) {
    if (!elLocation || label === locationText) return;
    locationText = label;
    let place = '';
    let streets = label;
    const split = label.indexOf(' · ');
    if (split >= 0) {
      place = label.slice(0, split);
      streets = label.slice(split + 3);
    } else if (placeNames.has(label) || (!label.includes(' & ') && !roadNames.has(label))) {
      place = label;
      streets = '';
    }
    const nodes = [];
    if (place) {
      const el = document.createElement('div');
      el.className = 'location-place';
      el.textContent = place;
      nodes.push(el);
    }
    if (streets) {
      const row = document.createElement('div');
      row.className = 'location-signs';
      if (streets.startsWith('near ')) {
        streets = streets.slice(5);
        const near = document.createElement('span');
        near.className = 'location-near';
        near.textContent = 'near';
        row.appendChild(near);
      }
      for (const name of streets.split(' & ')) {
        const sign = document.createElement('span');
        sign.className = 'street-sign';
        sign.textContent = name;
        row.appendChild(sign);
      }
      nodes.push(row);
    }
    elLocation.replaceChildren(...nodes);
  }

  function teleportTo(x, z, heading = Math.PI) {
    const destination = controllerManager.teleportActiveTo(x, z, heading);
    touchControls.reset();
    gamepadControls.reset();
    cameraSystem.resetForTeleport();
    selectCamera('chase', true);
    mapSystem.waypoint = {
      x: destination.x,
      z: destination.z,
      name: getLocationLabel(destination.x, destination.z)
    };
    return destination;
  }

  const mapSystem = new NYCMapSystem({
    controllerManager,
    cameraSystem,
    trafficSystem,
    allBlocks: cityBlocks.allBlocks,
    onToggle: (open) => {
      controllerManager.resetInput();
      touchControls.setEnabled(!open);
      gamepadControls.setEnabled(!open);
      const mapHint = document.getElementById('fullmap-hover-info');
      if (open && touchControls.available && mapHint) {
        mapHint.textContent = 'Tap to teleport · Drag to pan · Use + / − to zoom';
      }
    },
    onTeleport: teleportTo
  });

  teleportButtons.forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.getAttribute('data-teleport');
      const loc = TELEPORT_LOCATIONS[key];
      if (loc) {
        teleportTo(loc.x, loc.z, loc.heading);
      }
      closePopovers();
    });
  });

  const openMapBtn = document.getElementById('btn-open-map');
  if (openMapBtn) openMapBtn.addEventListener('click', () => mapSystem.toggleFullMap(true));

  if (hudToggleBtn) {
    hudToggleBtn.addEventListener('click', () => {
      document.body.classList.toggle('hud-minimized');
      const isMin = document.body.classList.contains('hud-minimized');
      hudToggleBtn.setAttribute('aria-pressed', String(isMin));
      hudToggleBtn.setAttribute('aria-label', isMin ? 'Show HUD' : 'Hide HUD');
      hudToggleBtn.title = isMin ? 'Show the HUD [H]' : 'Clean view: hide the HUD [H]';
      if (isMin) closePopovers();
    });
  }

  // Global keyboard shortcuts for modes (1-4), cameras (V / 5-0), and HUD (H)
  window.addEventListener('keydown', (e) => {
    if (isTypingInField(e)) return;
    switch (e.code) {
      case 'Digit1':
        selectMode('person');
        break;
      case 'Digit2':
        selectMode('car');
        break;
      case 'Digit3':
        selectMode('cyclist');
        break;
      case 'Digit4':
        selectMode('helicopter');
        break;
      case 'Digit5':
        selectCamera('chase', true);
        break;
      case 'Digit6':
        selectCamera('action', true);
        break;
      case 'Digit7':
        selectCamera('pov', true);
        break;
      case 'Digit8':
        selectCamera('fifthAve', true);
        break;
      case 'Digit9':
        selectCamera('timesSquare', true);
        break;
      case 'Digit0':
        selectCamera('chryslerGCT', true);
        break;
      case 'KeyV':
        cycleCamera(e.shiftKey ? -1 : 1);
        break;
      case 'KeyH':
        if (hudToggleBtn) hudToggleBtn.click();
        break;
      case 'KeyN':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey) audioSystem.setEnabled(!audioSystem.enabled);
        break;
      case 'KeyB':
        if (!e.repeat && !e.metaKey && !e.ctrlKey && !e.altKey && !mapSystem.isFullMapOpen) audioSystem.honk(controllerManager.getActiveEntity());
        break;
    }
  });

  window.addEventListener('resize', () => {
    cameraSystem.onResize(window.innerWidth, window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight);
    placeModeIndicator();
    if (mapSystem.isFullMapOpen) {
      mapSystem.resizeFullCanvas();
      mapSystem.renderFullMap();
    }
  });

  // Initialize the UI and chase camera around the restored player, or the default taxi on a first visit.
  selectMode(controllerManager.activeMode);
  selectCamera('chase', true);
  selectTime('golden');
  // the web fonts change the buttons' widths once they arrive
  if (document.fonts) document.fonts.ready.then(placeModeIndicator);
  await stepDone('ui');

  // The loading screen stays up while the first frame's shaders compile (precompileShaders(), see the loop) and
  // until the first frame is on screen
  if (loadingStatus) {
    loadingStatus.textContent = 'Compiling Shaders & Render Pipelines...';
  }

  // 6b. Pipelines. The city draws with several hundred: each needs its node graph built on the main thread (tens of
  //     milliseconds, once per instanced mesh, since three.js keys an instanced mesh's graph by the mesh) and its GPU
  //     pipeline compiled (up to seconds under the WebGL2 fallback). None is built in advance or inside a frame:
  //     async-pipelines.js skips a draw until its pipeline exists, builds a few graphs per frame and has the GPU
  //     process compile the pipelines in parallel. The opaque pass draws nearest first, so the street around the
  //     player fills in first; the loading screen stays up until everything within FIRST_FRAME_RADIUS is drawn, and
  //     the far side of the city appears while playing.
  const FIRST_FRAME_RADIUS = 80; // metres
  markInit('compile');

  // Auto quality learns from how the game runs here: the frame rate over 20 s of play, once the far pipelines had
  // 10 s to compile, decides whether the next visit starts a level lower (quality.js)
  function measureAutoQuality() {
    setTimeout(() => {
      let frames = 0;
      let hiddenMeanwhile = false;
      const started = performance.now();
      const onHide = () => { hiddenMeanwhile = true; };
      document.addEventListener('visibilitychange', onHide);
      const count = () => {
        frames++;
        if (performance.now() - started < 20000) {
          requestAnimationFrame(count);
          return;
        }
        document.removeEventListener('visibilitychange', onHide);
        if (!hiddenMeanwhile) learnAutoQuality(quality, (frames * 1000) / (performance.now() - started));
      };
      requestAnimationFrame(count);
    }, 10000);
  }

  // 6. Animation Loop
  let lastTime = performance.now();
  let elapsed = 0;
  let frameCount = 0;
  let fpsTimer = 0;
  let nextPlayerSave = 0;
  let warmedUp = false; // see the first frame below
  const STALL_MS = 4000;
  let lastBuiltNear = -1;
  let lastProgressAt = performance.now();

  if (elFps) elFps.textContent = '60';

  renderer.setAnimationLoop((now) => {
    pipelineGate.beginFrame();
    const rawDt = (now - lastTime) * 0.001;
    lastTime = now;
    const dt = Math.min(Math.max(rawDt, 0.001), 0.05);
    elapsed += dt;

    // Update 3rd-person controllers, camera, signals, traffic & vehicle collisions, building LODs, and dynamic shadow focus
    gamepadControls.update(dt);
    controllerManager.update(dt, elapsed);
    cameraSystem.update(dt, elapsed);
    streetDetails.signalClock.value = elapsed;
    trafficSystem.update(
      dt,
      elapsed,
      cameraSystem.currentPos,
      controllerManager.getActiveEntity(),
      controllerManager.activeMode,
      cameraSystem.camera
    );
    highwayTraffic.update(dt, cameraSystem.camera, controllerManager.getActiveEntity(), controllerManager.activeMode);
    if (!document.hidden && now >= nextPlayerSave) {
      savePlayerState();
      nextPlayerSave = now + 5000;
    }
    if (boroughs.update) boroughs.update(elapsed); // Roosevelt Island Tramway cabins
    cityBlocks.update(cameraSystem.currentPos.x, cameraSystem.currentPos.z);
    if (cityBlocks.updateLights) cityBlocks.updateLights(cameraSystem.camera);
    if (streetDetails.update) streetDetails.update(cameraSystem.camera);
    lightingSystem.update(cameraSystem.currentPos);
    mapSystem.update();
    audioSystem.update(dt, elapsed, cameraSystem.camera, lightingSystem.activePresetId === 'midnight');
    updateSceneCulling(cameraSystem.camera.position);
    remotePlayers.update(dt, cameraSystem.camera);
    shareState(now, controllerManager.getActiveEntity(), controllerManager.activeMode);

    // Render frame via TSL RenderPipeline (SSR + Bloom)
    viewPosition.copy(cameraSystem.camera.position);
    pipelineGate.setNearRadius(warmedUp ? 0 : FIRST_FRAME_RADIUS);
    renderPipeline.render();
    // A pipeline that never turns up (a driver that fails it without an error) must not hold the loading screen: no
    // progress for STALL_MS and the game starts with what it has
    if (pipelineGate.stats.builtNear !== lastBuiltNear) {
      lastBuiltNear = pipelineGate.stats.builtNear;
      lastProgressAt = now;
    }
    if (!warmedUp && pipelineGate.stats.waitingNear > 0 && now - lastProgressAt < STALL_MS) {
      // The loading screen stays up while the pipelines of the view around the player are created between frames;
      // the bar shows how many of those it has (the count of the ones still missing only grows while it is found)
      const { builtNear, waitingNear } = pipelineGate.stats;
      const share = builtNear / (builtNear + waitingNear);
      if (loadingStatus) loadingStatus.textContent = `Compiling Shaders & Render Pipelines... ${Math.round(share * 100)}%`;
      setLoadingProgress(share);
      reportProgress('compile', share);
    } else if (!warmedUp) {
      warmedUp = true;
      markInit('firstFrame');
      // The loading screen stays up until the GPU has got through the first frame (and the pipelines it compiled),
      // i.e. until the city is actually on screen; the rest of the city's pipelines compile after that
      const device = renderer.backend.device;
      Promise.resolve(device && device.queue.onSubmittedWorkDone()).catch(() => {}).then(() => {
        markInit('gpu');
        console.log(`[init] ${initTimings.join(', ')}; first frame waited on ${pipelineGate.stats.built} pipelines (${pipelineGate.stats.failed} failed)`);
        initTimings = null;
        if (loadingOverlay) loadingOverlay.classList.add('hidden');
        pipelineGate.setBudget(PLAYING_BUILD_BUDGET);
        audioSystem.ready = true;
        setLoadingProgress(1);
        reportReady();
        if (qualitySetting === 'auto') measureAutoQuality();
      });
    }

    // Telemetry uses wall time, not the clamped simulation step, so slow frames and high-refresh displays report
    // their actual frame rate (updates DOM every 250ms).
    frameCount++;
    fpsTimer += Math.max(0, rawDt);
    if (fpsTimer >= 0.25) {
      const currentFps = Math.round(frameCount / fpsTimer);
      frameCount = 0;
      fpsTimer = 0;

      const activeEnt = controllerManager.getActiveEntity();
      const mode = controllerManager.activeMode;
      const mph = Math.round(Math.abs(activeEnt.speed) * 2.237);
      const altFt = Math.max(0, Math.round(activeEnt.position.y * 3.281));

      if (elFps) {
        elFps.textContent = String(currentFps);
        elFps.className = currentFps >= 50 ? 'fps-ok' : currentFps >= 30 ? 'fps-warn' : 'fps-bad';
      }
      if (elSpeed) elSpeed.textContent = String(mph);
      if (elSpeedMeter) elSpeedMeter.style.transform = `scaleX(${Math.min(1, mph / (topSpeedMph[mode] || 80))})`;
      document.body.classList.toggle('is-boosting', controllerManager.keys.boost && mph > 0);
      if (elAltitude) elAltitude.textContent = altFt.toLocaleString('en-US');
      // The street corner of the player on the follow cameras, of the camera itself on the scenic ones
      const where = cameraSystem.getActivePreset().category === 'follow' ? activeEnt.position : cameraSystem.currentPos;
      renderLocation(getLocationLabel(where.x, where.z));
    }
  });
}

initApp().catch((e) => {
  reportFailure('error');
  console.error(e);
});
