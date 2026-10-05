/**
 * Which live format to hand this browser, and where each one lives.
 *
 * Media Source Extensions first wherever they exist (see `transportOrder`).
 * Below that, the two formats the element plays by itself.
 *
 * There is no feature test for "can play a progressive MP4 that never ends", so
 * this asks the one question that separates the two families: whether the
 * browser plays HLS on its own. Only Apple's engine does, and Apple's engine is
 * exactly the one that refuses the MP4 - on the iPhone, on the iPad, in Safari on
 * a Mac, and in every other browser on an iPhone, because they are all the same
 * engine underneath.
 *
 * The guess is not load-bearing. Both players fall back to the next format when
 * one does not start, so a browser this gets wrong loses a second, not a picture.
 *
 * Client-side. Both viewers share it so there is one answer rather than two that
 * drift.
 */

import { mediaSourceType } from "./live-player";

export type Transport = "mse" | "mp4" | "hls";

/**
 * Every format this browser might play, best first.
 *
 * Fed by hand ("mse") wherever the browser offers Media Source Extensions:
 * the first keyframe is the first frame on screen, and the picture stays live
 * rather than drifting seconds behind - see live-player. Then the two that are
 * handed to the element whole, in the order this browser is likeliest to take
 * them.
 *
 * On the server "mse" leads as well, which matters more than it looks: a
 * stream fed by hand renders no `src`, so the markup sent before hydration asks
 * for nothing. Handing it an MP4 address instead started a progressive stream on
 * every tile that was thrown away the moment the page woke up.
 */
export function transportOrder(): Transport[] {
    if (typeof document === "undefined") return ["mse", "mp4", "hls"];
    const apple = document.createElement("video").canPlayType("application/vnd.apple.mpegurl");
    const whole: Transport[] = apple ? ["hls", "mp4"] : ["mp4", "hls"];
    return mediaSourceType() ? ["mse", ...whole] : whole;
}

/** What to try first. */
export function preferredTransport(): Transport {
    return transportOrder()[0]!;
}

/** What to try when this one did not start, or null when everything has been. */
export function nextTransport(transport: Transport): Transport | null {
    const order = transportOrder();
    const at = order.indexOf(transport);
    return at === -1 ? (order[0] ?? null) : (order[at + 1] ?? null);
}

/** The other whole-file format, for when the first did not start. */
export function otherTransport(transport: Transport): Transport {
    return transport === "mp4" ? "hls" : "mp4";
}

/** Where a live stream is. Always a Polaris address: the relay is never named to
 *  a browser, which is also what makes this work from outside the house. */
export function streamSrc(cameraId: string, quality: "main" | "sub", transport: Transport): string {
    // A stream fed by hand reads the same fragmented MP4 the element would.
    return transport === "hls"
        ? `/api/home/cameras/${cameraId}/hls/stream.m3u8?q=${quality}`
        : `/api/home/cameras/${cameraId}/stream?q=${quality}`;
}

/**
 * A single frame, at the size it will be drawn.
 *
 * This is what is actually on screen for the first few seconds of every camera,
 * and for all of them on a device where the stream never starts - so it is asked
 * for at the width it will occupy rather than the camera's own, which is several
 * thousand pixels and most of a megabyte a time.
 *
 * `stamp` is what makes the next request a different one. Without it the browser
 * answers from its own cache and the picture never changes, which is exactly what
 * a frozen camera looks like.
 */
export function stillSrc(
    cameraId: string,
    stamp = 0,
    width?: number,
    /** Ask the relay for a shorter cache window, so the pictures are actually
     *  different from each other. Only for a screen showing one camera - see the
     *  snapshot route. */
    smooth = false
): string {
    // Unique to this page as well as to this picture, so the relay's answer can
    // be cached: an address that is never asked for twice cannot freeze a
    // picture, and the one that IS asked for twice - the frame a tile was
    // showing, by the camera opened from it - comes back with no wait. The very
    // first one stays plain, so the markup the server sends matches the page
    // that wakes up.
    const query = new URLSearchParams({ v: stamp > 0 ? `${pageId()}.${stamp}` : String(stamp) });
    if (width) query.set("w", String(width));
    if (smooth) query.set("smooth", "1");
    return `/api/home/cameras/${cameraId}/snapshot?${query.toString()}`;
}

/** A frame address `stillSrc` made unique to one page, which the snapshot route
 *  may therefore let the browser keep. */
export const VERSIONED_STILL = /^[a-z0-9]{6,16}\.[0-9]{1,12}$/;

let page: string | null = null;

/** Made on first use, which is always in the browser: the server only ever
 *  renders the plain first frame. */
function pageId(): string {
    page ??= Math.random().toString(36).slice(2, 10).padEnd(6, "0");
    return page;
}

/**
 * The last frame each camera drew on this page.
 *
 * Opening a camera used to start from nothing: a request for a fresh frame,
 * then a request for the stream, with a black rectangle in between. The tile it
 * was opened from had a picture of that camera on screen a moment earlier, so
 * the viewer starts from that one - out of the browser's cache, or captured off
 * the tile's own video, with no wait - and the fresh frames and the stream
 * replace it as they arrive.
 *
 * Only a recent one. A tile that has been playing video stopped asking for
 * pictures when it started, and its last picture from before then is a moment
 * that has passed; opening on it would show the reader something that is not
 * there any more.
 */
const shown = new Map<string, { src: string; at: number }>();

/** How old a remembered frame may be and still be shown as the camera. */
export const FRAME_FRESH_MS = 10_000;

export function rememberFrame(cameraId: string, src: string, at: number = Date.now()): void {
    shown.set(cameraId, { src, at });
}

export function lastFrame(cameraId: string, now: number = Date.now()): string | null {
    const found = shown.get(cameraId);
    if (!found || now - found.at > FRAME_FRESH_MS) return null;
    return found.src;
}

/** How wide a captured frame is kept. The tile's own size, about: it is a
 *  picture to open on for a moment, not one to look at closely. */
const CAPTURE_WIDTH = 960;

/**
 * The frame a playing video is showing, as a picture that needs no request.
 *
 * Null when there is nothing to capture yet, or when the browser will not hand
 * the pixels over.
 */
export function captureFrame(video: HTMLVideoElement): string | null {
    const { videoWidth, videoHeight } = video;
    if (videoWidth === 0 || videoHeight === 0) return null;
    const width = Math.min(videoWidth, CAPTURE_WIDTH);
    const height = Math.round((videoHeight * width) / videoWidth);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    try {
        context.drawImage(video, 0, 0, width, height);
        return canvas.toDataURL("image/jpeg", 0.8);
    } catch {
        return null;
    }
}
