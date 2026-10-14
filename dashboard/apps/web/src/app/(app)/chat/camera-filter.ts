"use client";

/**
 * Putting something between the camera and the call, the way `mic-filter` does
 * for the microphone.
 *
 * What people want from this is not a picture of a beach. It is that the call
 * carries them and not the kitchen behind them - the bed, the doorway somebody
 * walks through, the whiteboard with next quarter on it. A blur does that, and
 * so does a picture of their own, and both need the same thing underneath: a
 * model that looks at every frame and answers which pixels are the person.
 *
 * **MediaPipe's image segmenter** (`@mediapipe/tasks-vision`, Apache-2.0,
 * Google) with its selfie segmenter model is that model - the pairing LiveKit's
 * own `@livekit/track-processors` runs. It runs on the GPU, and so does every
 * step after it (`camera-compositor`): the mask is smoothed over time, its edge
 * refined against the picture, and the person composited over a blur that
 * leaves them out of it - Google's published recipe for Meet. The runtime and
 * the model are served from this origin out of `public/video`, so nothing about
 * a call reaches anybody else. About twelve megabytes, fetched the moment
 * somebody turns a background on and never before.
 *
 * A masked camera is a *different* track. Everything the raw camera track was
 * for - the device it came from, retuning it when the quality bar moves,
 * stopping it at the end - still refers to the raw one, so both are handed back
 * and both have to be let go of.
 *
 * Three things here are worth knowing before changing any of it:
 *
 * - **Nothing waits on an animation frame.** A call spends most of its life in a
 *   tab nobody is looking at, and a hidden tab gets no animation frames and has
 *   its timers throttled to about one a second - a camera that freezes the
 *   moment somebody reads their mail. Where the browser has insertable streams,
 *   each camera frame is handed over as it arrives and handed back as a track,
 *   with no timer at all. Elsewhere a worker's timer drives the frames, because
 *   a worker's timers are not throttled.
 * - **The output follows the camera's size, every frame.** Moving the quality
 *   bar retunes the device track in place (see `call-quality`), so the picture
 *   arriving here changes shape without anything being republished.
 * - **A model that stops answering blurs everything rather than nothing.**
 *   Somebody who turned this on did so to keep a room out of a call, and the
 *   failure that hands the raw room back is the one failure this must not have.
 */

import type { ImageSegmenter } from "@mediapipe/tasks-vision";
import { createCompositor, type Compositor } from "./camera-compositor";
import { CameraFailure, problemOf, type CameraProblem } from "./camera-problem";
import { backgroundImage, BLUR_PIXELS, type CameraBackground } from "./camera-background";
import {
    compositeParams,
    dropFrame,
    framePath,
    frameSupport,
    MODEL_FILE,
    targetFps,
    VIDEO_ASSETS_PATH,
    wasmFiles
} from "./camera-mask";
import {
    autoGain,
    cameraLook,
    followFrame,
    frameFor,
    lookFilter,
    lookIsPlain,
    meanLuma,
    personBox,
    WHOLE_FRAME,
    type CameraLook,
    type FrameBox
} from "./camera-look";

const ASSETS = VIDEO_ASSETS_PATH;

/**
 * How long any one step of starting up is given.
 *
 * Generous, because the step that takes the time is a download of several
 * megabytes on whatever line the reader is on. It is a ceiling on waiting
 * forever rather than a performance target.
 */
const START_TIMEOUT = 45_000;

/** How many frames in a row may fail before the model is treated as gone. */
const GIVE_UP = 10;

/** The copy of a frame the look measures - brightness, and where the person
 *  is. Small on purpose: reading pixels back is the one slow thing here. */
const SAMPLE_WIDTH = 48;
const SAMPLE_HEIGHT = 27;
/** How often, in frames, the look measures. A few times a second at 30 fps. */
const MEASURE_EVERY = 6;

/** The insertable-streams classes, which TypeScript's DOM library does not
 *  describe yet. Only what is used here. */
interface TrackProcessor {
    readonly readable: ReadableStream<VideoFrame>;
}
interface TrackGenerator extends MediaStreamTrack {
    readonly writable: WritableStream<VideoFrame>;
}
type TrackProcessorClass = new (init: { track: MediaStreamTrack }) => TrackProcessor;
type TrackGeneratorClass = new (init: { kind: "video" }) => TrackGenerator;

/** A camera with something between it and the call. */
export interface MaskedCamera {
    /** What to send, or null when it could not be built - see `problem`. */
    readonly track: MediaStreamTrack | null;
    /** Let go of the model, the canvases and the loop. The camera itself is the
     *  caller's to stop: this only undoes what it built. */
    readonly stop: () => Promise<void>;
    /** Which background is running - "off" when only the look is. */
    readonly using: CameraBackground;
    /**
     * Why there is no masked track, or null when nothing went wrong.
     *
     * Kept for the same reason the microphone's is: a filter that has never once
     * started in a deployment looks exactly like one that works.
     */
    readonly problem: CameraProblem | null;
}

/**
 * Build the pipeline, or answer null.
 *
 * Null means there was nothing to do: no background and no look was asked for,
 * or this is not a browser. Anything else comes back as a `MaskedCamera`, whose
 * `track` is null when it could not be built and whose `problem` then says why.
 *
 * Two passes, each only when it is wanted. The background is composited on the
 * GPU; the look - light, colour, framing - is then one more draw of that onto
 * what is sent, through a canvas filter and a crop.
 */
export async function maskCamera(
    track: MediaStreamTrack,
    asked: CameraBackground,
    image: string | null = backgroundImage(),
    look: CameraLook = cameraLook()
): Promise<MaskedCamera | null> {
    if (typeof window === "undefined" || typeof document === "undefined") return null;
    // A picture that is not there is not a background. Nothing is said about it
    // because nothing can be: the setting is only reachable from a menu that
    // offers it after a picture has been chosen.
    const background: CameraBackground = asked === "image" && !image ? "off" : asked;
    const finishing = !lookIsPlain(look);
    if (background === "off" && !finishing) return null;
    // The model is what says where the person is: the background needs it to
    // cut them out, framing to follow them. Light and colour need nothing.
    const segmenting = background !== "off" || look.frame === "auto";

    const path = framePath(frameSupport(window as unknown as Record<string, unknown>));
    if (!path) return refusal(background, { code: "noVideoOut", said: null });

    // What is sent when there is a look to apply; the GPU canvas otherwise.
    const canvas = finishing ? document.createElement("canvas") : null;
    const context = canvas?.getContext("2d") ?? null;
    const sample = finishing ? document.createElement("canvas") : null;
    const sampling = sample?.getContext("2d", { willReadFrequently: true }) ?? null;
    if (finishing && (!context || !sampling)) {
        return refusal(background, { code: "noCanvas", said: null });
    }
    if (sample) {
        sample.width = SAMPLE_WIDTH;
        sample.height = SAMPLE_HEIGHT;
    }

    // The GPU canvas: the model runs on its context and the compositor draws
    // on it, so the mask never leaves the graphics card.
    const surface = segmenting ? document.createElement("canvas") : null;
    const gl = surface
        ? (surface.getContext("webgl2", {
              alpha: false,
              antialias: false,
              depth: false,
              stencil: false,
              premultipliedAlpha: false,
              preserveDrawingBuffer: false
          }) as WebGL2RenderingContext | null)
        : null;
    if (segmenting && !gl) {
        return refusal(background, { code: "noWebgl", said: null });
    }

    let video: HTMLVideoElement | null = null;
    let segmenter: ImageSegmenter | null = null;
    let compositor: Compositor | null = null;
    let ticker: Worker | null = null;
    let reader: ReadableStreamDefaultReader<VideoFrame> | null = null;
    let writer: WritableStreamDefaultWriter<VideoFrame> | null = null;
    let stopped = false;
    let failures = 0;
    let answered = false;
    let frames = 0;
    let clock = 0;
    let gain = 1;
    let crop: FrameBox = WHOLE_FRAME;
    let aim: FrameBox = WHOLE_FRAME;

    /** Everything built here, undone in the order it was built. */
    const teardown = async (): Promise<void> => {
        stopped = true;
        ticker?.terminate();
        ticker = null;
        await reader?.cancel().catch(() => undefined);
        reader = null;
        await writer?.close().catch(() => undefined);
        writer = null;
        compositor?.dispose();
        compositor = null;
        try {
            segmenter?.close();
        } catch {
            // Already gone with its context; nothing left to free.
        }
        segmenter = null;
        gl?.getExtension("WEBGL_lose_context")?.loseContext();
        if (video) video.srcObject = null;
    };

    try {
        let picture: HTMLImageElement | null = null;
        if (background === "image" && image) {
            picture = new Image();
            picture.src = image;
            await within(START_TIMEOUT, picture.decode());
        }
        if (segmenting && gl && surface) {
            const loaded = await within(START_TIMEOUT, loader());
            segmenter = await within(START_TIMEOUT, createSegmenter(loaded, surface));
            compositor = createCompositor(gl, {
                params:
                    background === "off"
                        ? null
                        : compositeParams(
                              background,
                              BLUR_PIXELS[background === "strong" ? "strong" : "blur"]
                          ),
                blindParams: compositeParams("strong", BLUR_PIXELS.strong),
                image: picture
            });
        }
    } catch (caught) {
        await teardown();
        return refusal(background, problemOf(caught));
    }

    /**
     * One frame through the model and the compositor. Answers what to send.
     *
     * The model is asked synchronously: its answer is a texture on the shared
     * context, folded into the smoothed mask before the result is let go of.
     */
    function render(
        source: HTMLVideoElement | VideoFrame,
        width: number,
        height: number
    ): CanvasImageSource {
        if (!segmenter || !compositor || !surface) return finish(source, width, height);
        if (failures < GIVE_UP) {
            // The model wants strictly increasing timestamps, and two frames
            // can arrive inside the same millisecond.
            clock = Math.max(performance.now(), clock + 1);
            try {
                const result = segmenter.segmentForVideo(source, clock);
                try {
                    // Background first and the person last: the selfie model has
                    // one output, which the runtime hands back as both.
                    const masks = result.confidenceMasks ?? [];
                    const answer = masks[masks.length - 1];
                    if (answer) {
                        compositor.track(answer.getAsWebGLTexture(), answer.width, answer.height);
                        answered = true;
                    }
                } finally {
                    result.close();
                }
                failures = 0;
            } catch {
                failures += 1;
            }
        }
        const blind = failures >= GIVE_UP || !answered;

        if (look.frame === "auto" && frames % MEASURE_EVERY === 0) {
            const pixels = blind ? null : compositor.readMask(SAMPLE_WIDTH, SAMPLE_HEIGHT);
            aim = pixels ? frameFor(personBox(pixels, SAMPLE_WIDTH, SAMPLE_HEIGHT)) : WHOLE_FRAME;
        }
        if (background === "off") return finish(source, width, height);
        compositor.render({ source, width, height, blind });
        return finish(surface, width, height);
    }

    /**
     * The look: light, colour and framing, as one draw onto what is sent.
     *
     * The brightness is measured from a tiny copy of the frame every so often,
     * and eased towards rather than jumped to, so a lamp switched on is a
     * picture that settles rather than one that flashes.
     */
    function finish(source: CanvasImageSource, width: number, height: number): CanvasImageSource {
        frames += 1;
        if (!finishing || !canvas || !context) return source;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        if (look.light === "auto" && sampling && frames % MEASURE_EVERY === 1) {
            sampling.globalCompositeOperation = "copy";
            sampling.drawImage(source, 0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT);
            const wanted = autoGain(
                meanLuma(sampling.getImageData(0, 0, SAMPLE_WIDTH, SAMPLE_HEIGHT).data)
            );
            gain += (wanted - gain) * 0.3;
        }
        crop = look.frame === "auto" ? followFrame(crop, aim) : WHOLE_FRAME;
        context.globalCompositeOperation = "copy";
        context.filter = lookFilter(look, gain);
        context.drawImage(
            source,
            crop.x * width,
            crop.y * height,
            crop.w * width,
            crop.h * height,
            0,
            0,
            width,
            height
        );
        context.filter = "none";
        context.globalCompositeOperation = "source-over";
        return canvas;
    }

    const fps = targetFps(track.getSettings().frameRate);
    let out: MediaStreamTrack | null = null;

    try {
        if (path === "insertable") {
            const scope = window as unknown as {
                MediaStreamTrackProcessor: TrackProcessorClass;
                MediaStreamTrackGenerator: TrackGeneratorClass;
            };
            const generator = new scope.MediaStreamTrackGenerator({ kind: "video" });
            reader = new scope.MediaStreamTrackProcessor({ track }).readable.getReader();
            writer = generator.writable.getWriter();
            out = generator;
            let last = -Infinity;

            /** One camera frame in, one out. False once the camera has ended. */
            const step = async (): Promise<boolean> => {
                const read = await reader?.read();
                if (!read || read.done || !read.value) return false;
                const frame = read.value;
                try {
                    const at = frame.timestamp / 1000;
                    // A camera that is off is unpublished rather than sent
                    // black, so there is nothing here worth a model's time.
                    if (stopped || !track.enabled || dropFrame(at - last, fps)) return true;
                    last = at;
                    const sent = render(frame, frame.displayWidth, frame.displayHeight);
                    // The generator takes the frame and closes it.
                    await writer?.write(new VideoFrame(sent, { timestamp: frame.timestamp }));
                } finally {
                    frame.close();
                }
                return true;
            };

            // The first frame, before this returns, and it is not a formality:
            // the model compiles its shaders and builds its graph on the first
            // frame it sees, a task of about a second that holds the main
            // thread. Held here, that second is inside the caller's `await`,
            // where a screen has already said it is starting.
            await within(START_TIMEOUT, step());
            void (async () => {
                while (!stopped) {
                    const going = await step().catch(() => !stopped);
                    if (!going) break;
                }
            })();
        } else {
            const playing = document.createElement("video");
            video = playing;
            playing.autoplay = true;
            playing.playsInline = true;
            playing.muted = true;
            // Its own copy of the camera, never the caller's stream object:
            // pointing a video element at a stream the call is also using is how
            // one of them ends up restarting the other.
            playing.srcObject = new MediaStream([track]);
            // autoplay is unreliable for an element that is not in the document.
            await playing.play().catch(() => undefined);
            await within(START_TIMEOUT, firstFrame(playing));

            const tick = (): void => {
                if (stopped) return;
                const width = playing.videoWidth;
                const height = playing.videoHeight;
                if (track.readyState === "live" && track.enabled && width && height) {
                    render(playing, width, height);
                }
            };
            // The first frame before this returns - see the insertable path.
            tick();
            const sent = (canvas ?? surface) as HTMLCanvasElement;
            out = sent.captureStream(fps).getVideoTracks()[0] ?? null;
            if (!out) throw new CameraFailure("noVideoOut");

            ticker = new Worker(tickerScript(), { name: "Call background" });
            ticker.onmessage = () => {
                tick();
                ticker?.postMessage(Math.round(1000 / fps));
            };
            ticker.postMessage(0);
        }
    } catch (caught) {
        await teardown();
        out?.stop();
        return refusal(background, problemOf(caught));
    }

    const sending = out;
    return {
        track: sending,
        using: background,
        problem: null,
        stop: async () => {
            await teardown();
            sending.stop();
        }
    };
}

/** A background that was asked for and could not be built. */
function refusal(background: CameraBackground, problem: CameraProblem): MaskedCamera {
    return { track: null, using: background, problem, stop: async () => undefined };
}

type Vision = typeof import("@mediapipe/tasks-vision");

interface Loaded {
    readonly vision: Vision;
    readonly model: Uint8Array;
    readonly simd: boolean;
}

/**
 * The runtime and the model, fetched once per page.
 *
 * The model is fetched here rather than by the runtime, so that a deployment
 * that never staged it says so in words instead of in a wasm abort.
 *
 * A failure is not remembered. The next attempt tries again, because the reasons
 * this fails - a tab that was offline, a deployment whose assets arrived a
 * moment later - are all reasons it might work now.
 */
let loading: Promise<Loaded> | null = null;

function loader(): Promise<Loaded> {
    if (loading) return loading;
    loading = (async () => {
        const response = await fetch(`${ASSETS}/${MODEL_FILE}`).catch(() => null);
        if (!response?.ok) {
            throw new CameraFailure("noModel");
        }
        const model = new Uint8Array(await response.arrayBuffer());
        const vision = await import("@mediapipe/tasks-vision");
        const simd = await vision.FilesetResolver.isSimdSupported();
        return { vision, model, simd };
    })();
    loading.catch(() => {
        loading = null;
    });
    return loading;
}

/**
 * The segmenter, on the GPU where it will run and on the CPU where it will not
 * - a machine with WebGL 2 but a blocklisted driver still gets a background,
 * only a slower one. Both share the canvas, so the mask is a texture either way.
 */
async function createSegmenter(loaded: Loaded, canvas: HTMLCanvasElement): Promise<ImageSegmenter> {
    const files = wasmFiles(loaded.simd);
    const fileset = {
        wasmLoaderPath: `${ASSETS}/${files.loader}`,
        wasmBinaryPath: `${ASSETS}/${files.binary}`
    };
    const build = (delegate: "GPU" | "CPU") =>
        loaded.vision.ImageSegmenter.createFromOptions(fileset, {
            // A copy each time: the runtime may take ownership of the buffer.
            baseOptions: { modelAssetBuffer: loaded.model.slice(), delegate },
            canvas,
            runningMode: "VIDEO",
            outputConfidenceMasks: true,
            outputCategoryMask: false
        });
    try {
        return await build("GPU");
    } catch {
        return await build("CPU");
    }
}

/**
 * The worker that drives the frames where insertable streams are missing.
 *
 * A blob rather than a file of its own: it is one line, and a file would be one
 * more thing to stage and to be missing. What matters is only that it is a
 * worker at all - see the note at the top of this file about hidden tabs.
 */
let tickerUrl: string | null = null;

function tickerScript(): string {
    if (!tickerUrl) {
        tickerUrl = URL.createObjectURL(
            new Blob(
                [
                    "let at=0;onmessage=(e)=>{clearTimeout(at);at=setTimeout(()=>postMessage(0),e.data)};"
                ],
                { type: "text/javascript" }
            )
        );
    }
    return tickerUrl;
}

/**
 * Resolve once the browser has painted.
 *
 * Exported from here because it exists for what is above: building a background
 * takes a second of the main thread the first time in a tab, and a screen that
 * sets "Starting..." and calls straight into it never gets that line onto the
 * glass - the freeze arrives first and what stays on screen is the frame
 * before. Two frames, because one only means the next paint was scheduled.
 */
export function afterPaint(): Promise<void> {
    if (typeof requestAnimationFrame !== "function") return Promise.resolve();
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
}

/** Resolve once the camera has actually produced a frame: everything after this
 *  reads `videoWidth`, which is zero until it has. */
function firstFrame(video: HTMLVideoElement): Promise<void> {
    if (video.readyState >= 2 && video.videoWidth > 0) return Promise.resolve();
    return new Promise((resolve) => {
        video.onloadeddata = () => resolve();
    });
}

/** A promise with a ceiling on how long it may take. */
function within<T>(ms: number, promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
        promise,
        new Promise<T>((_, reject) => {
            timer = setTimeout(() => reject(new CameraFailure("tooSlow")), ms);
        })
    ]).finally(() => clearTimeout(timer));
}
