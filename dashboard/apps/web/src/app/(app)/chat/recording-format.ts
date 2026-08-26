/**
 * What this browser can record video into, and what to call the file.
 *
 * Its own module because two things record video here - a screen clip in the
 * composer and a call - and the answer has to be the same for both. It is a
 * question about the browser rather than about either feature.
 *
 * MP4 with H.264 first, wherever the browser will make one. WebM with VP9 is a
 * third smaller for the same picture, and it is the wrong default anyway: a
 * `.webm` will not open in most desktop players, will not go into a video
 * editor, and is a container decision nobody asked to make on behalf of whoever
 * is sent the file. Recording straight into MP4 is also the only honest way to
 * offer it as one - converting a video in a page means shipping a transcoder and
 * an afternoon of somebody's battery.
 *
 * WebM is what is left for a browser that will not record MP4, and it is played
 * back perfectly well by the browser that made it.
 */

const TYPES = [
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4;codecs=avc1,opus",
    "video/mp4",
    "video/webm;codecs=vp9,opus",
    "video/webm;codecs=vp8,opus",
    "video/webm"
];

/** What this browser can record into, or null when it cannot record video. */
export function recordingType(): string | null {
    if (typeof window === "undefined" || typeof MediaRecorder === "undefined") return null;
    return TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
}

/** The extension that matches what was recorded. A file named for a container it
 *  is not is worse than no name at all: it opens in nothing and looks corrupt. */
export function recordingExtension(type: string): string {
    return type.startsWith("video/mp4") ? "mp4" : "webm";
}
