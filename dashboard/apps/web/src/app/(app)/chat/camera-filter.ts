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
 * **MediaPipe's selfie segmentation** (Apache-2.0, Google) is that model, and it
 * is the same one Jitsi and Nextcloud Talk run for the same feature. It is an
 * Emscripten build - a loader, a wasm binary and a set of weights - served from
 * this origin out of `public/video`, so nothing about a call reaches anybody
 * else and there is no account, key or quota anywhere in it. It is not small:
 * about six megabytes, fetched at the moment somebody turns a background on and
 * never before.
 *
 * A masked camera is a *different* track: the frames are composited onto a
 * canvas and what the call sends is the canvas's own stream. Everything the raw
 * camera track was for - the device it came from, retuning it when the quality
 * bar moves, stopping it at the end - still refers to the raw one, so both are
 * handed back and both have to be let go of.
 *
 * Three things here are worth knowing before changing any of it:
 *
 * - **The frames are driven by a worker, not by `requestAnimationFrame`.** A
 *   call spends most of its life in a tab nobody is looking at, and a hidden tab
 *   gets no animation frames at all and has its timers throttled to about one a
 *   second. Either of those is a camera that freezes the moment somebody reads
 *   their mail - visible to the whole room and to nobody more than the person it
 *   is happening to, who cannot see their own tile. A worker's timers are not
 *   throttled, which is the only reason this one exists. Jitsi carries the same
 *   worker for the same reason.
 * - **The canvas follows the camera's size, every frame.** Moving the quality
 *   bar retunes the device track in place (see `call-quality`), so the picture
 *   arriving here changes shape without anything being republished. A canvas
 *   left at the old size would quietly scale it.
 * - **A model that stops answering blurs everything rather than nothing.**
 *   Somebody who turned this on did so to keep a room out of a call, and the
 *   failure that hands the raw room back is the one failure this must not have.
 */

import { backgroundImage, BLUR_PIXELS, type CameraBackground } from "./camera-background";

/** Where the staged model and its loader are served from. */
const ASSETS = "/video";

/** What the loader exports on the window once the script has run. Its own
 *  types, so the contract is the package's rather than one written here. */
type Segmenter = import("@mediapipe/selfie_segmentation").SelfieSegmentation;
type SegmenterResults = import("@mediapipe/selfie_segmentation").Results;
type SegmenterClass = new (config: { locateFile: (file: string) => string }) => Segmenter;

/**
 * How long any one step of starting up is given.
 *
 * Generous, because the step that takes the time is a six-megabyte download on
 * whatever line the reader is on. It is a ceiling on waiting forever rather than
 * a performance target: what it stops is a call sitting on an unmasked camera
 * with no explanation because a file never arrived.
 */
const START_TIMEOUT = 45_000;

/**
 * How much the edge of the cut-out is softened, in pixels.
 *
 * The mask has a hard edge and a person does not. Blurring the mask before the
 * frame is drawn through it is what stops a head looking cut out with scissors;
 * a picture behind needs more of it than a blur does, because a blurred
 * background hides its own seam.
 */
const EDGE_OVER_IMAGE = 4;
const EDGE_OVER_BLUR = 8;

/** How many frames in a row may fail before the model is treated as gone. */
const GIVE_UP = 10;

/** A camera with something between it and the call. */
export interface MaskedCamera {
    /** What to send, or null when it could not be built - see `problem`. */
    readonly track: MediaStreamTrack | null;
    /** Let go of the canvas, the model and the loop. The camera itself is the
     *  caller's to stop: this only undoes what it built. */
    readonly stop: () => Promise<void>;
    /** Which background is running. */
    readonly using: CameraBackground;
    /**
     * Why there is no masked track, or null when nothing went wrong.
     *
     * Kept for the same reason the microphone's is: a filter that has never once
     * started in a deployment looks exactly like one that works - the setting
     * says "Blur my background", the room is still in the call, and there is
     * nothing anywhere to read.
     */
    readonly problem: string | null;
}

/**
 * Build the pipeline, or answer null.
 *
 * Null means there was nothing to do: no background was asked for, or this is
 * not a browser. Anything else comes back as a `MaskedCamera`, whose `track` is
 * null when it could not be built and whose `problem` then says why.
 */
export async function maskCamera(
    track: MediaStreamTrack,
    background: CameraBackground,
    image: string | null = backgroundImage()
): Promise<MaskedCamera | null> {
    if (background === "off") return null;
    if (typeof window === "undefined" || typeof document === "undefined") return null;
    // A picture that is not there is not a background. Nothing is said about it
    // because nothing can be: the setting is only reachable from a menu that
    // offers it after a picture has been chosen.
    if (background === "image" && !image) return null;

    const video = document.createElement("video");
    video.autoplay = true;
    video.playsInline = true;
    // Its own copy of the camera, never the caller's stream object: pointing a
    // video element at a stream the call is also using is how one of them ends
    // up restarting the other.
    video.srcObject = new MediaStream([track]);
    // autoplay is unreliable for an element that is not in the document.
    await video.play().catch(() => undefined);

    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d");
    if (!context) return refusal(background, "This browser has no canvas to draw on.");

    let picture: HTMLImageElement | null = null;
    let segmenter: Segmenter | null = null;
    let ticker: Worker | null = null;
    let stopped = false;
    let failures = 0;

    /** Everything built here, undone in the order it was built. */
    const teardown = async (): Promise<void> => {
        stopped = true;
        ticker?.terminate();
        ticker = null;
        await segmenter?.close().catch(() => undefined);
        segmenter = null;
        video.srcObject = null;
        picture = null;
    };

    try {
        if (background === "image" && image) {
            picture = new Image();
            picture.src = image;
            await within(START_TIMEOUT, picture.decode());
        }
        await within(START_TIMEOUT, firstFrame(video));

        const Segmentation = await within(START_TIMEOUT, loader());
        segmenter = new Segmentation({ locateFile: (file) => `${ASSETS}/${file}` });
        // The landscape model - the wider, cheaper of the two, and the one a
        // call is shaped like.
        segmenter.setOptions({ modelSelection: 1, selfieMode: false });
        segmenter.onResults(draw);
        await within(START_TIMEOUT, segmenter.initialize());
    } catch (caught) {
        await teardown();
        return refusal(background, reasonOf(caught));
    }

    /**
     * One frame, composited.
     *
     * The order is the whole trick and it is Jitsi's: the mask is laid down
     * first and softened, the frame is drawn *into* it so only the person
     * survives, and the background is then slid underneath. Three composite
     * operations and no pixel is ever read back into JavaScript.
     */
    function draw(results: SegmenterResults): void {
        if (stopped || !context) return;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) return;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }

        const blur = BLUR_PIXELS[background === "strong" ? "strong" : "blur"];

        context.globalCompositeOperation = "copy";
        context.filter = `blur(${picture ? EDGE_OVER_IMAGE : EDGE_OVER_BLUR}px)`;
        context.drawImage(results.segmentationMask, 0, 0, width, height);

        context.globalCompositeOperation = "source-in";
        context.filter = "none";
        context.drawImage(results.image, 0, 0, width, height);

        context.globalCompositeOperation = "destination-over";
        if (picture) {
            context.drawImage(picture, 0, 0, width, height);
        } else {
            context.filter = `blur(${blur}px)`;
            // Drawn larger than the canvas by the width of the blur, which is
            // the difference between a blurred room and a blurred room inside a
            // dark frame: a blur samples past the edge of what it is given, and
            // past the edge of the canvas there is nothing to sample. Pushing
            // the faded border outside the picture costs one multiplication.
            context.drawImage(
                results.image,
                -blur * 2,
                -blur * 2,
                width + blur * 4,
                height + blur * 4
            );
        }

        context.filter = "none";
        context.globalCompositeOperation = "source-over";
    }

    /**
     * The room, with nobody cut out of it.
     *
     * What is drawn when the model has stopped answering. Everything is blurred
     * rather than nothing: somebody who turned a background on did so to keep a
     * room out of a call, and quietly handing that room back because an inference
     * failed is the one outcome here that is worse than a worse picture.
     */
    function drawBlind(): void {
        if (!context) return;
        const width = video.videoWidth;
        const height = video.videoHeight;
        if (!width || !height) return;
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
        const blur = BLUR_PIXELS.strong;
        context.globalCompositeOperation = "copy";
        context.filter = `blur(${blur}px)`;
        context.drawImage(video, -blur * 2, -blur * 2, width + blur * 4, height + blur * 4);
        context.filter = "none";
        context.globalCompositeOperation = "source-over";
    }

    const settings = track.getSettings();
    // The camera's own rate where it reports one. Held to something a model can
    // keep up with: a 60 fps webcam asked for 60 segmentations a second is a
    // fan at full speed for a picture nobody can tell apart from 30.
    const fps = Math.min(30, Math.max(15, Math.round(settings.frameRate ?? 30)));

    ticker = new Worker(tickerScript(), { name: "Call background" });
    ticker.onmessage = () => {
        void (async () => {
            if (stopped) return;
            // A camera that is off is unpublished rather than sent black, so
            // there is nothing here worth a model's time. A camera that has
            // ended - a lid, a cable, another application - is the same.
            if (track.readyState !== "live" || !track.enabled) {
                ticker?.postMessage(Math.round(1000 / fps));
                return;
            }
            try {
                if (failures < GIVE_UP) {
                    await segmenter?.send({ image: video });
                    failures = 0;
                } else {
                    drawBlind();
                }
            } catch {
                failures += 1;
                if (failures >= GIVE_UP) drawBlind();
            }
            ticker?.postMessage(Math.round(1000 / fps));
        })();
    };
    ticker.postMessage(0);

    const out = canvas.captureStream(fps).getVideoTracks()[0] ?? null;
    if (!out) {
        await teardown();
        return refusal(background, "This browser would not let a canvas be sent as video.");
    }

    return {
        track: out,
        using: background,
        problem: null,
        stop: async () => {
            await teardown();
            out.stop();
        }
    };
}

/** A background that was asked for and could not be built. */
function refusal(background: CameraBackground, problem: string): MaskedCamera {
    return { track: null, using: background, problem, stop: async () => undefined };
}

/**
 * The loader, fetched once per page.
 *
 * A classic script rather than an import, because that is what the package is:
 * an Emscripten build that exports itself onto the window and then fetches its
 * own wasm by name, relative to wherever it was served from. Bundling it would
 * put six megabytes into every page that can reach a call and still leave the
 * wasm to be fetched by URL.
 *
 * A failure is not remembered. The next attempt tries again, because the reasons
 * this fails - a tab that was offline, a deployment whose assets arrived a
 * moment later - are all reasons it might work now.
 */
let loading: Promise<SegmenterClass> | null = null;

function loader(): Promise<SegmenterClass> {
    if (loading) return loading;
    loading = new Promise<SegmenterClass>((resolve, reject) => {
        const here = window as unknown as { SelfieSegmentation?: SegmenterClass };
        if (here.SelfieSegmentation) {
            resolve(here.SelfieSegmentation);
            return;
        }
        const script = document.createElement("script");
        script.src = `${ASSETS}/selfie_segmentation.js`;
        script.async = true;
        script.onload = () => {
            if (here.SelfieSegmentation) resolve(here.SelfieSegmentation);
            else reject(new Error("The background model loaded but is not what Polaris expects."));
        };
        script.onerror = () =>
            reject(new Error("The background model is not on this server. An update adds it."));
        document.head.append(script);
    });
    loading.catch(() => {
        loading = null;
    });
    return loading;
}

/**
 * The worker that drives the frames.
 *
 * A blob rather than a file of its own: it is one line, and a file would be a
 * fourth thing to stage and a fourth thing to be missing. What matters is only
 * that it is a worker at all - see the note at the top of this file about hidden
 * tabs.
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
    return Promise.race([
        promise,
        new Promise<T>((_, reject) =>
            setTimeout(() => reject(new Error("It took too long to start.")), ms)
        )
    ]);
}

/**
 * A failure in words, and deliberately the browser's own.
 *
 * The same reasoning as `mic-filter`'s: "the script could not be loaded" and
 * "out of memory" send somebody to two different places, and the line under the
 * setting is the only place either of them appears.
 */
function reasonOf(caught: unknown): string {
    const message = caught instanceof Error ? caught.message : String(caught ?? "");
    const said = message.trim().replace(/\s+/g, " ");
    if (!said) return "It would not start, and said nothing about why.";
    return said.length > 160 ? `${said.slice(0, 157)}...` : said;
}
