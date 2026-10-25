// js/async-pipelines.js
// No frame ever stops to build a pipeline. three.js builds whatever a draw call needs on the spot: the node graph on
// the main thread and the GPU pipeline synchronously, so the first frame - which also draws the shadow maps and the
// post-processing passes that no precompile reaches - held the main thread for over ten seconds. Here a draw whose
// pipeline is not ready is skipped: its node graph is built within a small time budget per frame and its pipeline is
// created asynchronously (createRenderPipelineAsync on WebGPU, KHR_parallel_shader_compile on WebGL2), and it is drawn
// from the first frame after the pipeline exists. Renderer internals used here are those of the pinned three.js
// release (`_renderObjectDirect`, `_handleObjectFunction`, `_objects`, `_nodes`, `_geometries`, `_bindings`,
// `_pipelines`), the same ones Renderer.compileAsync() itself goes through.

import { Sphere } from 'three/webgpu';

const _sphere = new Sphere();

// How far an object is from `position`: 0 for what has no bounds to measure (the post-processing passes), and never
// near in a shadow map (orthographic cascades), which fills in once the game is on screen
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
    if (failed.has(renderObject)) return;
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
    Promise.allSettled(promises).then(() => {
      building.delete(renderObject);
      if (this._pipelines.isReady(renderObject)) {
        stats.built++;
        if (nearOnes.has(renderObject)) stats.builtNear++;
      } else if (promises.length > 0) {
        failed.add(renderObject);
        stats.failed++;
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
