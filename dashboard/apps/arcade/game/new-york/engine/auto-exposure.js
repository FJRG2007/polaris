import { TempNode, NodeUpdateType, RenderTarget, QuadMesh, NodeMaterial, RendererUtils, HalfFloatType } from 'three/webgpu';
import { Fn, float, vec2, vec3, vec4, texture, uniform, log2, exp, exp2, clamp, dot, mix, max } from 'three/tsl';

// js/auto-exposure.js
// Centre-weighted auto exposure: 64 taps of the HDR scene on an 8x8 grid, weighted by a Gaussian around the centre
// of the frame, averaged in log2 luminance (the geometric mean, Reinhard et al. 2002 "Photographic Tone
// Reproduction"), then eased towards over time (exponential adaptation, frame-rate independent) in a 1x1 target
// that ping-pongs between two textures. The result is an exposure multiplier: key / mean luminance, clamped.

const GRID = 8;
const SIGMA = 0.24;
const LUMA = vec3(0.2126, 0.7152, 0.0722);

class AutoExposureNode extends TempNode {
  static get type() {
    return 'AutoExposureNode';
  }

  constructor(inputNode, { key = 0.18, min = 0.55, max: maxExposure = 2.2, rate = 1.6 } = {}) {
    super('float');
    this.inputNode = inputNode;
    this.updateBeforeType = NodeUpdateType.FRAME;
    const options = { type: HalfFloatType, depthBuffer: false };
    this.targets = [new RenderTarget(1, 1, options), new RenderTarget(1, 1, options)];
    this.index = 0;
    this.previous = texture(this.targets[1].texture);
    this.current = texture(this.targets[0].texture);
    this.key = uniform(key);
    this.minExposure = uniform(min);
    this.maxExposure = uniform(maxExposure);
    this.rate = uniform(rate);
    this.deltaTime = uniform(1 / 60);
    this.firstFrame = uniform(1);
    this.material = new NodeMaterial();
    this.quad = new QuadMesh(this.material);
    this.lastTime = null;
    this.rendererState = undefined;
  }

  updateBefore(frame) {
    const { renderer } = frame;
    const now = performance.now();
    this.deltaTime.value = this.lastTime === null ? 1 / 60 : Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;
    const write = this.targets[this.index];
    const read = this.targets[1 - this.index];
    this.previous.value = read.texture;
    this.current.value = write.texture;
    this.rendererState = RendererUtils.resetRendererState(renderer, this.rendererState);
    renderer.setRenderTarget(write);
    this.quad.render(renderer);
    RendererUtils.restoreRendererState(renderer, this.rendererState);
    this.index = 1 - this.index;
    this.firstFrame.value = 0;
  }

  setup(builder) {
    const input = this.inputNode;
    const measure = Fn(() => {
      let sum = float(0);
      let weights = 0;
      for (let y = 0; y < GRID; y++) {
        for (let x = 0; x < GRID; x++) {
          const u = (x + 0.5) / GRID;
          const v = (y + 0.5) / GRID;
          const w = Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / (2 * SIGMA * SIGMA));
          weights += w;
          sum = sum.add(log2(max(dot(input.sample(vec2(u, v)).rgb, LUMA), 0.0001)).mul(w));
        }
      }
      const target = log2(clamp(this.key.div(exp2(sum.div(weights))), this.minExposure, this.maxExposure));
      const previous = this.previous.sample(vec2(0.5)).r;
      const blend = float(1).sub(exp(this.rate.mul(this.deltaTime).negate()));
      return vec4(this.firstFrame.greaterThan(0.5).select(target, mix(previous, target, blend)), 0, 0, 1);
    });
    this.material.fragmentNode = measure().context(builder.getSharedContext());
    this.material.needsUpdate = true;
    return exp2(this.current.sample(vec2(0.5)).r);
  }

  dispose() {
    for (const target of this.targets) target.dispose();
    this.material.dispose();
  }
}

const autoExposure = (inputNode, options) => new AutoExposureNode(inputNode, options);

export { AutoExposureNode, autoExposure };
