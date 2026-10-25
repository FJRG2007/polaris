// js/async-pipelines.js
// No frame ever stops to build a pipeline. three.js builds whatever a draw call needs on the spot: the node graph on
// the main thread and the GPU pipeline synchronously, so the first frame - which also draws the shadow maps and the
// post-processing passes that no precompile reaches - held the main thread for over ten seconds. Here a draw whose
// pipeline is not ready is skipped: its node graph is built within a small time budget per frame and its pipeline is
// created asynchronously (createRenderPipelineAsync on WebGPU, KHR_parallel_shader_compile on WebGL2), and it is drawn
// from the first frame after the pipeline exists. Renderer internals used here are those of the pinned three.js
// release (`_renderObjectDirect`, `_handleObjectFunction`, `_objects`, `_nodes`, `_geometries`, `_bindings`,
// `_pipelines`), the same ones Renderer.compileAsync() itself goes through.
// An opaque draw whose pipeline fails is not left out: it is drawn with a plain stand-in material (fallbackFor), since a
// shared pipeline that fails would otherwise hide every object that uses it.

import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, Sphere } from 'three/webgpu';

const _sphere = new Sphere();

// How far an object is from `position`: 0 for what has no bounds to measure (the post-processing passes), and never
// near in a shadow map (orthographic cascades), which fills in once the game is on screen
const _fallbacks = new WeakMap();
const FALLBACK_COPY = ['color', 'map', 'alphaMap', 'opacity', 'alphaTest', 'side', 'depthWrite', 'depthTest', 'vertexColors', 'fog',
  'roughness', 'metalness', 'positionNode'];

// The material drawn in place of an opaque one whose pipeline failed: same kind of shading (lit or unlit), colour,
// texture and vertex placement (instancing included), none of the custom output stages (MRT, output, lighting nodes).
// A first stand-in keeps the material's colour node; if that one fails too, a second goes without it. A transparent
// effect (smoke, glow, decal) or a sprite is left out instead: its look is all in its nodes, and a plain quad in its place reads as
// a glitch. null when there is nothing left to try.
function fallbackFor(material) {
  const level = material.fallbackLevel ?? 0;
  const lit = material.isMeshStandardMaterial || material.isMeshPhongMaterial || material.isMeshLambertMaterial;
  // Only a scene surface: a post-processing pass's material is none of these, and a plain quad would cover the screen
  if (level >= 2 || material.transparent || !(lit || material.isMeshBasicMaterial)) return null;
  let fallback = _fallbacks.get(material);
  if (fallback) return fallback;
  fallback = lit ? new MeshStandardNodeMaterial() : new MeshBasicNodeMaterial();
  for (const key of FALLBACK_COPY) {
    if (material[key] !== undefined && key in fallback) fallback[key] = material[key];
  }
  if (level === 0) fallback.colorNode = material.colorNode ?? null;
  fallback.name = `${material.name || material.type} (fallback ${level + 1})`;
  fallback.fallbackLevel = level + 1;
  _fallbacks.set(material, fallback);
  console.warn(`[pipelines] ${material.name || material.type} failed to compile, drawn with a plain material`);
  return fallback;
}

function distanceTo(object, camera, position) {
  let bounds = null;
  if (object.isInstancedMesh) {
    if (!object.boundingSphere) object.computeBoundingSphere();
    bounds = object.boundingSphere;
  } else if (object.geometry && object.frustumCulled) {
    if (!object.geometry.boundingSphere) object.geometry.computeBoundingSphere();
    bounds = object.geometry.boundingSphere;
  }
  if (!bounds) return 0;
  if (camera.isOrthographicCamera) return Infinity;
  _sphere.copy(bounds).applyMatrix4(object.matrixWorld);
  return Math.max(0, _sphere.center.distanceTo(position) - _sphere.radius);
}

/**
 * `near()` returns the view's position: draws within the radius given to setNearRadius() of it are counted apart
 * (`waitingNear`, `builtNear`), for the loading screen to wait on those alone.
 */
function drawOnlyCompiled(renderer, { budgetMs = 6, near = null } = {}) {
  let budget = budgetMs;
  let nearRadius = 0;
  const nearOnes = new WeakSet();
  const direct = renderer._renderObjectDirect;
  const building = new Set(); // render objects whose pipeline is being created
  const failed = new WeakSet(); // render objects whose pipeline could not be created: never retried, never waited on
  const stats = { waiting: 0, waitingNear: 0, built: 0, builtNear: 0, failed: 0 };
  let spent = 0;
  let builtThisFrame = 0;

  function renderObjectWhenReady(object, material, scene, camera, lightsNode, group, clippingContext, passId) {
    const renderObject = this._objects.get(object, material, scene, camera, lightsNode, this._currentRenderContext, clippingContext, passId);
    if (this._pipelines.isReady(renderObject)) {
      direct.call(this, object, material, scene, camera, lightsNode, group, clippingContext, passId);
      return;
    }
    if (failed.has(renderObject)) {
      const fallback = fallbackFor(material);
      if (fallback) renderObjectWhenReady.call(this, object, fallback, scene, camera, lightsNode, group, clippingContext, passId);
      return;
    }
    stats.waiting++;
    if (nearRadius > 0 && near && distanceTo(object, camera, near()) <= nearRadius) {
      stats.waitingNear++;
      nearOnes.add(renderObject);
    }
    if (building.has(renderObject)) {
      // What it draws from still has to be drawn meanwhile: the post-processing quad's scene pass renders the city in
      // the quad's updateBefore()
      this._nodes.updateBefore(renderObject);
      return;
    }
    // One build per frame at the least, so a frame always makes progress
    if (spent >= budget && builtThisFrame > 0) return;
    const started = performance.now();
    renderObject.drawRange = object.geometry.drawRange;
    renderObject.group = group;
    const promises = [];
    try {
      this._nodes.updateBefore(renderObject);
      this._geometries.updateForRender(renderObject);
      this._nodes.updateForRender(renderObject);
      this._bindings.updateForRender(renderObject);
      this._pipelines.getForRender(renderObject, promises);
      this._nodes.updateAfter(renderObject);
    } catch (e) {
      console.warn('[pipelines]', e);
      failed.add(renderObject);
      stats.failed++;
      return;
    } finally {
      spent += performance.now() - started;
      builtThisFrame++;
    }
    building.add(renderObject);
    const pipeline = this._pipelines.get(renderObject).pipeline;
    Promise.allSettled(promises).then(() => {
      building.delete(renderObject);
      if (this._pipelines.isReady(renderObject)) {
        stats.built++;
        if (nearOnes.has(renderObject)) stats.builtNear++;
      } else if (promises.length > 0 && this._pipelines.get(renderObject).pipeline === pipeline) {
        // The pipeline this build waited on could not be created. One that changed meanwhile (the object's material
        // or geometry needed a new one) is simply built again on its next draw.
        failed.add(renderObject);
        stats.failed++;
        console.warn(`[pipelines] ${material.name || material.type} (${object.name || object.type}) failed to compile`);
      }
    });
  }

  renderer._renderObjectDirect = renderObjectWhenReady;
  if (renderer._handleObjectFunction === direct) renderer._handleObjectFunction = renderObjectWhenReady;

  return {
    stats,
    /** Call before each frame: resets the build budget and the count of draws that had to wait. */
    beginFrame() {
      spent = 0;
      stats.waiting = 0;
      stats.waitingNear = 0;
      builtThisFrame = 0;
    },
    /** The build time allowed per frame, in milliseconds: generous behind the loading screen, small during play. */
    setBudget(ms) {
      budget = ms;
    },
    /** Draws within `radius` metres of the view count as near (0: none does). */
    setNearRadius(radius) {
      nearRadius = radius;
    },
    /** Pipelines still being created. */
    get building() {
      return building.size;
    }
  };
}

export { drawOnlyCompiled };
