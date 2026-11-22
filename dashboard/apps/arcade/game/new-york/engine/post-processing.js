import * as THREE from 'three/webgpu';
import {
  Fn,
  uniform,
  float,
  vec2,
  vec3,
  vec4,
  dot,
  mix,
  min,
  max,
  pow,
  smoothstep,
  length,
  screenUV,
  screenSize,
  screenCoordinate,
  interleavedGradientNoise,
  renderOutput,
  rtt,
  int,
  clamp,
} from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { ao as gtao } from 'three/addons/tsl/display/GTAONode.js';
import { radialBlur } from 'three/addons/tsl/display/radialBlur.js';
import { autoExposure } from './auto-exposure.js';

// Scene-linear color grading and lens bloom, composed in the existing final render pass, then the display transform.
// The tone mapper is AgX (Troy Sobotka's Blender AgX, as fitted for three.js after Filament's implementation): it
// desaturates towards white in the highlights instead of skewing hue the way ACES' per-channel curve does, so
// neon, brake lights and the low sun keep their colour. Its flatter base is answered by the grade's contrast.
// The display transform runs here rather than in RenderPipeline (`outputColorTransform = false` on the pipeline), so
// the last step can be a dither in display space: half a code value of interleaved gradient noise that breaks the
// banding 8-bit output leaves in the sky gradient and fog.
//
// Before the grade, by graphics level (quality.js):
//   ao          ground-truth ambient occlusion (Jimenez et al. 2016, "Practical Real-Time Strategies for Accurate
//               Indirect Occlusion", three.js GTAONode) at half resolution, darkening creases, kerbs and under cars
//   shafts      light shafts from the sun, as a post-process (Mitchell, "Volumetric Light Scattering as a
//               Post-Process", GPU Gems 3 ch. 13): the visible sky near the sun, drawn at half resolution, smeared
//               towards the sun's place on screen with a decaying radial blur, so buildings cut it into beams
//   motionBlur  camera motion blur from depth reprojection (Rosado, "Motion Blur as a Post-Processing Effect",
//               GPU Gems 3 ch. 27): each pixel's world position is projected with last frame's camera, and the
//               colour is averaged along the difference

// Exposure and white balance belong to the camera, independently of the physical lighting presets.
// Keep exposure restrained for ACES; stronger bloom stays selective so midtones retain their contrast.
const LOOKS = {
  golden:   { exposure: 1.10, contrast: 1.20, saturation: 1.16, balance: [1.045, 1.00, 0.955], bloom: 0.24, threshold: 1.20, auto: 0.55, shafts: 0.45 },
  midday:   { exposure: 1.06, contrast: 1.18, saturation: 1.14, balance: [1.015, 1.00, 0.985], bloom: 0.18, threshold: 1.35, auto: 0.55, shafts: 0.25 },
  twilight: { exposure: 1.12, contrast: 1.17, saturation: 1.16, balance: [1.025, 0.995, 1.015], bloom: 0.28, threshold: 1.05, auto: 0.45, shafts: 0.35 },
  midnight: { exposure: 1.10, contrast: 1.15, saturation: 1.12, balance: [0.985, 1.00, 1.035], bloom: 0.30, threshold: 1.00, auto: 0.35, shafts: 0 }
};

// `bloom: false` (the Low graphics level) leaves the bloom passes out.
function createPostProcessing(
  renderer,
  sceneColor,
  reflections,
  { bloom: withBloom = true, depth = null, normal = null, camera = null, ao = false, shafts = 0, motionBlur = false, viewZ = null } = {}
) {
  renderer.toneMapping = THREE.AgXToneMapping;
  // Exposure is applied before bloom so its threshold follows the image's exposed brightness.
  renderer.toneMappingExposure = 1.0;

  const exposure = uniform(1.0);
  const autoStrength = uniform(0.5);
  const contrast = uniform(1.0);
  const saturation = uniform(1.0);
  const balance = uniform(new THREE.Vector3(1, 1, 1));
  // 0 to 1: how hurt the player is right now (the shooter sets it); drives the red vignette and lens fringing
  const damage = uniform(0);

  // Lens fringing under damage: red and blue sampled a little apart along the radius
  const fringe = screenUV.sub(0.5).mul(damage.mul(0.012));
  let hdr = vec3(
    sceneColor.sample(screenUV.add(fringe)).r,
    sceneColor.rgb.g,
    sceneColor.sample(screenUV.sub(fringe)).b
  ).add(reflections.rgb);

  // Last frame's view-projection, for the motion blur's reprojection (update() keeps it)
  const previousViewProjection = uniform(new THREE.Matrix4());
  const blurStrength = uniform(0);
  // The camera's horizontal and vertical projection scale (projectionMatrix[0][0], [1][1])
  const projectionScale = uniform(new THREE.Vector2(1, 1));
  // The scene camera's world matrix: inside the full-screen pass the camera nodes name the pass's own quad camera
  const viewToWorld = uniform(new THREE.Matrix4());
  if (motionBlur && viewZ && camera) {
    // View-space position from the pass's linear view depth (independent of the depth buffer's direction)
    const ndc = vec2(screenUV.x.mul(2).sub(1), float(1).sub(screenUV.y.mul(2)));
    const distance = viewZ.abs();
    const viewPosition = vec3(ndc.div(projectionScale).mul(distance), distance.negate());
    const worldPosition = viewToWorld.mul(vec4(viewPosition, 1));
    const previousClip = previousViewProjection.mul(worldPosition);
    const previousUV = previousClip.xy.div(previousClip.w).mul(vec2(0.5, -0.5)).add(0.5);
    const motion = screenUV.sub(previousUV).mul(blurStrength);
    // Capped to 4% of the screen, and none for the sky at infinity
    const capped = motion.mul(min(float(1), float(0.04).div(max(length(motion), 0.0001))));
    let sum = hdr;
    const taps = 6;
    for (let i = 1; i <= taps; i++) {
      sum = sum.add(sceneColor.sample(screenUV.sub(capped.mul((i / taps) - 0.5))).rgb);
    }
    hdr = sum.div(taps + 1);
  }

  if (ao && depth && normal && camera) {
    const aoPass = gtao(depth, normal, camera);
    aoPass.resolutionScale = 0.5;
    aoPass.samples.value = 12;
    aoPass.radius.value = 0.6;
    hdr = hdr.mul(mix(float(1), aoPass.getTextureNode().r, 0.85));
  }

  // The sun's place on screen (x, y in UV) and how much of it faces the camera (update() keeps both)
  const sunScreen = uniform(new THREE.Vector2(0.5, 0.5));
  const sunFacing = uniform(0);
  const shaftColor = uniform(new THREE.Color(1, 0.86, 0.68));
  const shaftStrength = uniform(0.35);
  if (shafts > 0 && depth) {
    // Visible sky only (the far plane: 0 with a reversed depth buffer), brighter towards the sun
    const isSky = renderer.reversedDepthBuffer ? depth.r.lessThan(0.000001) : depth.r.greaterThan(0.999999);
    const aspect = screenSize.x.div(screenSize.y);
    const nearSun = smoothstep(0.75, 0.0, length(screenUV.sub(sunScreen).mul(vec2(aspect, 1))));
    const mask = isSky.select(min(sceneColor.rgb, vec3(4)).mul(nearSun), vec3(0));
    const maskTexture = rtt(vec4(mask, 1));
    maskTexture.setResolutionScale?.(0.5);
    const beams = radialBlur(maskTexture, {
      center: sunScreen,
      count: int(shafts),
      weight: float(0.9),
      decay: float(0.955),
      exposure: float(1)
    });
    hdr = hdr.add(beams.rgb.mul(shaftColor).mul(shaftStrength.mul(sunFacing)).div(shafts / 8));
  }
  // The camera's metering, tempered: a dark canyon opens up, the sky does not blow the street out
  const metered = autoExposure(sceneColor);
  const exposed = max(hdr, vec3(0)).mul(exposure).mul(pow(metered, autoStrength)).mul(balance);

  // Limit only bloom's peak radiance, scaling RGB together to retain neon and lamp colors.
  // The original HDR image keeps its full range for the tone mapper's highlight shoulder.
  const peak = max(max(exposed.r, exposed.g), exposed.b);
  const bloomInput = vec4(exposed.mul(float(8.0).div(max(peak, 8.0))), 1.0);
  const bloomPass = withBloom ? bloom(bloomInput, 0.24, 0.40, 1.20) : null;
  if (bloomPass) {
    bloomPass.smoothWidth.value = 0.30;
    bloomPass.setResolutionScale(0.35);
  }

  const outputNode = Fn(() => {
    const color = (bloomPass ? exposed.add(bloomPass.rgb) : exposed).toVar();
    const luma = dot(color, vec3(0.2126, 0.7152, 0.0722)).toVar();

    // Gentle cool shadow / warm highlight separation; multiply rather than lifting the black level.
    const shadows = mix(vec3(0.965, 1.005, 1.045), vec3(1), smoothstep(0.02, 0.60, luma));
    const highlights = mix(vec3(1), vec3(1.035, 1.005, 0.965), smoothstep(0.60, 3.0, luma));
    color.mulAssign(shadows.mul(highlights));

    // Contrast pivots around middle gray and scales RGB together, avoiding per-channel gamma shifts.
    color.mulAssign(pow(max(luma, 0.0001).div(0.18), contrast.sub(1.0)));
    const gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
    const chroma = max(max(color.r, color.g), color.b).sub(min(min(color.r, color.g), color.b));
    const vibrance = float(0.10).mul(float(1).sub(chroma.div(max(max(max(color.r, color.g), color.b), 0.0001))));
    color.assign(max(mix(vec3(gray), color, saturation.add(vibrance)), vec3(0)));

    // Normalize by the corner radius so the lens falloff remains subtle in portrait and landscape.
    const aspect = screenSize.x.div(screenSize.y);
    const radius = length(screenUV.sub(0.5).mul(vec2(aspect, 1))).div(length(vec2(aspect, 1).mul(0.5)));
    const vignette = float(1).sub(smoothstep(0.35, 1.0, radius).mul(0.12));
    color.mulAssign(vignette);
    // Damage: the edges darken and run red
    const hurt = smoothstep(0.25, 1.05, radius).mul(damage);
    color.assign(mix(color, color.mul(vec3(0.9, 0.12, 0.08)).add(vec3(0.05, 0, 0)), hurt));
    const display = renderOutput(vec4(color, 1.0));
    const dither = interleavedGradientNoise(screenCoordinate.xy).sub(0.5).div(255);
    return vec4(display.rgb.add(dither), 1.0);
  })();

  function applyPreset(id) {
    const look = LOOKS[id] || LOOKS.golden;
    exposure.value = look.exposure;
    contrast.value = look.contrast;
    saturation.value = look.saturation;
    autoStrength.value = look.auto;
    shaftStrength.value = look.shafts ?? 0.35;
    balance.value.set(...look.balance);
    if (!bloomPass) return;
    bloomPass.strength.value = look.bloom;
    bloomPass.threshold.value = look.threshold;
  }

  const sunWorld = new THREE.Vector3();
  const viewProjection = new THREE.Matrix4();
  /** Once a frame, after the camera moved: the sun's place on screen and last frame's camera for the blur. */
  function update(view, sunDirection, dt) {
    if (!view) return;
    sunWorld.copy(sunDirection).normalize();
    const facing = sunWorld.dot(view.getWorldDirection(new THREE.Vector3()));
    sunWorld.multiplyScalar(1000).add(view.position).project(view);
    sunScreen.value.set(sunWorld.x * 0.5 + 0.5, 0.5 - sunWorld.y * 0.5);
    sunFacing.value = Math.max(0, facing) ** 0.5 * (sunWorld.z < 1 ? 1 : 0);
    // A shutter of about 1/50 s whatever the frame rate: the blur covers the distance moved in that time
    blurStrength.value = Number.isFinite(dt) && dt > 0 ? Math.min(1.5, 0.02 / dt) * 0.5 : 0;
    projectionScale.value.set(view.projectionMatrix.elements[0], view.projectionMatrix.elements[5]);
    view.updateMatrixWorld();
    viewToWorld.value.copy(view.matrixWorld);
    previousViewProjection.value.copy(viewProjection);
    viewProjection.multiplyMatrices(view.projectionMatrix, view.matrixWorldInverse);
  }

  applyPreset('golden');
  return { outputNode, applyPreset, damage, update };
}

export { createPostProcessing };
