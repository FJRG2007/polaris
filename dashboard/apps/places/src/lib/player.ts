/**
 * Which of the two live formats to hand this browser, and where each one lives.
 *
 * There is no feature test for "can play a progressive MP4 that never ends", so
 * this asks the one question that separates the two families: whether the
 * browser plays HLS on its own. Only Apple's engine does, and Apple's engine is
 * exactly the one that refuses the MP4 - on the iPhone, on the iPad, in Safari on
 * a Mac, and in every other browser on an iPhone, because they are all the same
 * engine underneath.
 *
 * The guess is not load-bearing. Both players fall back to the other format when
 * one does not start, so a browser this gets wrong loses a second, not a picture.
 *
 * Client-side. Both viewers share it so there is one answer rather than two that
 * drift.
 */

export type Transport = "mp4" | "hls";

/** What to try first. MP4 on the server, where there is no browser to ask - the
 *  markup is replaced on hydration before anything is fetched. */
export function preferredTransport(): Transport {
    if (typeof document === "undefined") return "mp4";
    return document.createElement("video").canPlayType("application/vnd.apple.mpegurl") ? "hls" : "mp4";
}

/** The other one, for when the first did not start. */
export function otherTransport(transport: Transport): Transport {
    return transport === "mp4" ? "hls" : "mp4";
}

/** Where a live stream is. Always a Polaris address: the relay is never named to
 *  a browser, which is also what makes this work from outside the house. */
export function streamSrc(cameraId: string, quality: "main" | "sub", transport: Transport): string {
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
    const query = new URLSearchParams({ v: String(stamp) });
    if (width) query.set("w", String(width));
    if (smooth) query.set("smooth", "1");
    return `/api/home/cameras/${cameraId}/snapshot?${query.toString()}`;
}
