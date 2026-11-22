import { Fn, float, texture, uniform, clamp, max, mix, sqrt, interleavedGradientNoise, vogelDiskSample, screenCoordinate } from 'three/tsl';

// js/soft-shadows.js
// Contact-hardening sun shadows for the High and Ultra levels: sharp where an object meets the ground, wider the
// farther the blocker is from the surface it shades, as in Percentage-Closer Soft Shadows (Fernando, NVIDIA 2005).
//
// PCSS proper reads raw depths in its blocker search, but the shadow atlas here is bound with a comparison sampler, so
// the search asks the same question twice through it instead: what share of the search disc is shadowed by blockers
// more than NEAR metres in front of the receiver, and what share by blockers more than FAR metres in front. The ratio
// of the two is the share of distant blockers, which sets the filter radius between MIN and MAX texels. The filter
// then takes Vogel-disk samples (Vogel 1979, as in three.js' own PCF filter) rotated per pixel by interleaved gradient
// noise (Jimenez, "Next Generation Post Processing in Call of Duty: Advanced Warfare", SIGGRAPH 2014).

const SEARCH_SAMPLES = 8;
const FILTER_SAMPLES = 12;

/**
 * A `shadow.filterNode` for a directional (or cascaded sun) shadow.
 * @param {object} options
 * @param {boolean} options.reversed       the renderer's reversed depth buffer (the shadow compare is `>=` then)
 * @param {{ value: number }} options.depthPerMeter  shadow-map depth units per world metre (1 / camera depth range)
 */
function contactHardeningShadowFilter({
  reversed, depthPerMeter, searchTexels = 10, minTexels = 0.8, maxTexels = 5.5, nearBlocker = 1.25, farBlocker = 10
}) {
  // Moving the reference depth towards the light by d asks "is there a blocker more than d in front?"
  const towardLight = reversed ? 1 : -1;
  return Fn(({ depthTexture, shadowCoord, shadow, depthLayer }) => {
    const lit = (uv, ref) => {
      let depth = texture(depthTexture, uv);
      if (depthTexture.isArrayTexture) depth = depth.depth(depthLayer);
      return depth.compare(ref);
    };
    const texel = float(1).div(uniform(shadow.mapSize).x);
    const phi = interleavedGradientNoise(screenCoordinate.xy).mul(6.28318530718);
    const z = shadowCoord.z;
    const zNear = z.add(depthPerMeter.mul(nearBlocker * towardLight));
    const zFar = z.add(depthPerMeter.mul(farBlocker * towardLight));

    let litNear = float(0);
    let litFar = float(0);
    const searchRadius = texel.mul(searchTexels);
    for (let i = 0; i < SEARCH_SAMPLES; i++) {
      const uv = shadowCoord.xy.add(vogelDiskSample(i, SEARCH_SAMPLES, phi).mul(searchRadius));
      litNear = litNear.add(lit(uv, zNear));
      litFar = litFar.add(lit(uv, zFar));
    }
    const shadedNear = float(1).sub(litNear.div(SEARCH_SAMPLES));
    const shadedFar = float(1).sub(litFar.div(SEARCH_SAMPLES));
    const farShare = clamp(shadedFar.div(max(shadedNear, 0.001)), 0, 1);
    const radius = texel.mul(mix(float(minTexels), float(maxTexels), sqrt(farShare)));

    let sum = float(0);
    for (let i = 0; i < FILTER_SAMPLES; i++) {
      sum = sum.add(lit(shadowCoord.xy.add(vogelDiskSample(i, FILTER_SAMPLES, phi.add(1.7)).mul(radius)), z));
    }
    return sum.div(FILTER_SAMPLES);
  });
}

export { contactHardeningShadowFilter };
