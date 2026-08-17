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

/** A single frame. Used as the poster under a stream that is still starting, and
 *  as the picture when there is no stream to be had. */
export function stillSrc(cameraId: string, stamp = 0): string {
    return `/api/home/cameras/${cameraId}/snapshot?v=${stamp}`;
}
