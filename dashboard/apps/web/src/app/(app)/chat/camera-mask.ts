/**
 * The numbers behind a camera background, kept apart from the GPU code that
 * uses them so they can be read, reasoned about and tested without a GPU.
 *
 * The approach is the one Google published for Meet ("Background Features in
 * Google Meet, Powered by Web ML", Google AI Blog, 2020) and the one LiveKit's
 * `@livekit/track-processors` ships on top of MediaPipe's image segmenter: a
 * small segmentation model run on a downscaled frame, its mask smoothed over
 * time, its edge refined against the full-size picture with a joint bilateral
 * filter, a background blur that leaves the person out of what it averages, and
 * a little of the new background's light wrapped onto the person's outline.
 */

import type { CameraBackground } from "./camera-background";

/** Where the staged runtime and model are served from (`copy-video-assets`). */
export const VIDEO_ASSETS_PATH = "/video";

/** The segmentation model: MediaPipe's selfie segmenter, square 256x256,
 *  float16. Committed under `assets/video` and staged beside the runtime. */
export const MODEL_FILE = "selfie_segmenter.tflite";

/** The two builds of the runtime; which one runs depends on whether the
 *  browser has WebAssembly SIMD. */
export function wasmFiles(simd: boolean): { loader: string; binary: string } {
    const name = simd ? "vision_wasm_internal" : "vision_wasm_nosimd_internal";
    return { loader: `${name}.js`, binary: `${name}.wasm` };
}

/** Every file a background can ask `/video` for. */
export const VIDEO_ASSETS: readonly string[] = [
    ...Object.values(wasmFiles(true)),
    ...Object.values(wasmFiles(false)),
    MODEL_FILE
];

/**
 * Temporal smoothing of the mask.
 *
 * A model run thirty times a second answers slightly differently each time
 * about the same still pixel, which is the shimmer along a shoulder. Averaging
 * over time hides it, and averaging over time is also what leaves a ghost of a
 * hand behind when it moves. So the weight of the new answer depends on how
 * much it disagrees with the old: a small change is noise and is mostly
 * ignored, a large one is movement and is taken at once.
 */
export const TEMPORAL = {
    /** Weight of the new mask where nothing moved. */
    still: 0.4,
    /** Below this much change a pixel is considered still... */
    low: 0.06,
    /** ...and above this, moving: the new mask is taken as it is. */
    high: 0.3
} as const;

/** How much of the newest mask a pixel takes, given how far it moved. The
 *  temporal shader computes exactly this; it is spelled out here to be tested. */
export function blendWeight(delta: number): number {
    const t = clamp01((Math.abs(delta) - TEMPORAL.low) / (TEMPORAL.high - TEMPORAL.low));
    const eased = t * t * (3 - 2 * t);
    return TEMPORAL.still + (1 - TEMPORAL.still) * eased;
}

/** One step of the smoothing, for a single pixel. */
export function smoothMaskValue(previous: number, current: number): number {
    return previous + (current - previous) * blendWeight(current - previous);
}

/**
 * The edge refinement: a joint bilateral filter over the mask, guided by the
 * picture. The model sees a 256-pixel square; the picture has hair in it. Each
 * output pixel takes the mask from its neighbours, weighted by how close they
 * are and how alike in colour, so the mask's edge moves to where the picture's
 * edge is.
 */
export const REFINE = {
    /** Taps either side of the centre, in mask texels. */
    radius: 3,
    /** Spatial falloff, in taps. */
    sigmaSpace: 2,
    /** Colour falloff, as a distance in 0-1 RGB. */
    sigmaColor: 0.1,
    /** The refined mask is computed at most this wide or tall, then sampled up. */
    maxSide: 640
} as const;

/** Size of the refinement pass for a frame: the frame's own, capped. */
export function refineSize(width: number, height: number): { width: number; height: number } {
    return scaledToFit(width, height, REFINE.maxSide);
}

/** How much smaller the background blur is computed than the frame. */
export const BLUR_DOWNSCALE = 4;
/** The longest blur kernel, in taps either side, at the downscaled size. */
export const MAX_BLUR_RADIUS = 24;

/** What the compositor needs to know about one background. */
export interface CompositeParams {
    /** Gaussian sigma of the background blur, in downscaled pixels; 0 for a
     *  picture, which is not blurred. */
    readonly sigma: number;
    /** Taps either side for that sigma. */
    readonly radius: number;
    /** Where the refined mask turns from background to person. A narrow band is
     *  a crisp edge; a picture needs crisper than a blur, which hides its seam. */
    readonly edge: readonly [number, number];
    /** How much of the background's light is wrapped onto the outline. */
    readonly wrap: number;
}

/**
 * The parameters for a background. `blurPixels` is the strength the settings
 * name (`BLUR_PIXELS`), as a standard deviation in full-size pixels.
 */
export function compositeParams(
    background: Exclude<CameraBackground, "off">,
    blurPixels: number
): CompositeParams {
    if (background === "image") return { sigma: 0, radius: 0, edge: [0.4, 0.6], wrap: 0.25 };
    const sigma = Math.max(0.5, blurPixels / BLUR_DOWNSCALE);
    return {
        sigma,
        radius: Math.min(MAX_BLUR_RADIUS, Math.ceil(sigma * 3)),
        edge: [0.3, 0.7],
        wrap: 0.12
    };
}

/** Size of the downscaled blur buffers. */
export function blurSize(width: number, height: number): { width: number; height: number } {
    return {
        width: Math.max(1, Math.round(width / BLUR_DOWNSCALE)),
        height: Math.max(1, Math.round(height / BLUR_DOWNSCALE))
    };
}

/**
 * Where to draw a picture so it covers a frame of another shape without being
 * stretched: scaled by the larger of the two ratios and centred, so the excess
 * falls off the edges. A picture with no size yet is drawn over the frame.
 */
export function coverRect(
    sourceWidth: number,
    sourceHeight: number,
    width: number,
    height: number
): { x: number; y: number; width: number; height: number } {
    if (sourceWidth <= 0 || sourceHeight <= 0) return { x: 0, y: 0, width, height };
    const scale = Math.max(width / sourceWidth, height / sourceHeight);
    const drawnWidth = sourceWidth * scale;
    const drawnHeight = sourceHeight * scale;
    return {
        x: (width - drawnWidth) / 2,
        y: (height - drawnHeight) / 2,
        width: drawnWidth,
        height: drawnHeight
    };
}

/** `coverRect` as a texture transform: picture uv = frame uv * scale + offset. */
export function coverUv(
    sourceWidth: number,
    sourceHeight: number,
    width: number,
    height: number
): [number, number, number, number] {
    const at = coverRect(sourceWidth, sourceHeight, width, height);
    return [width / at.width, height / at.height, -at.x / at.width, -at.y / at.height];
}

/** How frames reach the model and leave for the call. */
export type FramePath = "insertable" | "canvas";

/** What the browser offers, as far as choosing a frame path goes. */
export interface FrameSupport {
    readonly processor: boolean;
    readonly generator: boolean;
    readonly videoFrame: boolean;
    readonly captureStream: boolean;
}

/**
 * Which way frames go, or null when there is none.
 *
 * Insertable streams (Chromium) hand over each camera frame as it arrives and
 * take the result as a track, with no timer in between - so nothing is
 * throttled when the tab is hidden, and nothing is drawn twice. Elsewhere the
 * camera plays into a video element, a worker's timer drives the frames, and a
 * canvas is captured as the track.
 */
export function framePath(support: FrameSupport): FramePath | null {
    if (support.processor && support.generator && support.videoFrame) return "insertable";
    return support.captureStream ? "canvas" : null;
}

/** What `framePath` needs, read from a global scope. */
export function frameSupport(scope: Record<string, unknown>): FrameSupport {
    const canvas = scope.HTMLCanvasElement as { prototype?: object } | undefined;
    return {
        processor: typeof scope.MediaStreamTrackProcessor === "function",
        generator: typeof scope.MediaStreamTrackGenerator === "function",
        videoFrame: typeof scope.VideoFrame === "function",
        captureStream: Boolean(canvas?.prototype && "captureStream" in canvas.prototype)
    };
}

/** The camera's frame rate, held to what a model can keep up with: a 60 fps
 *  webcam asked for 60 segmentations a second is a fan at full speed for a
 *  picture nobody can tell apart from 30. */
export function targetFps(reported: number | undefined): number {
    return Math.min(30, Math.max(15, Math.round(reported ?? 30)));
}

/** Whether a frame arriving `elapsed` ms after the last one processed should be
 *  dropped to hold `fps`. A little slack, so a camera at exactly the target
 *  rate is never cut in half by jitter. */
export function dropFrame(elapsed: number, fps: number): boolean {
    return elapsed < (1000 / fps) * 0.75;
}

function scaledToFit(width: number, height: number, side: number) {
    const scale = Math.min(1, side / Math.max(width, height, 1));
    return {
        width: Math.max(1, Math.round(width * scale)),
        height: Math.max(1, Math.round(height * scale))
    };
}

function clamp01(value: number): number {
    return value < 0 ? 0 : value > 1 ? 1 : value;
}
