"use client";

/**
 * A still from a video, taken where the video already is.
 *
 * A list of messages with videos in it has to draw something, and "video.webm"
 * on a black rectangle tells nobody what they are looking at - which is the
 * whole reason every messenger shows a frame. The frame has to come from
 * somewhere, and there are only three places it can:
 *
 * - the server, which would mean a transcoder on the machine Polaris runs on,
 *   for the one job it is not: it is a control plane, not a media pipeline.
 * - every reader, on demand, which means fetching the head of every video in
 *   the room to draw a picture of it - the exact cost a thumbnail exists to
 *   avoid, paid once per person per open instead of once ever.
 * - the browser that is sending it, which already has the whole file in memory
 *   and is about to upload it anyway.
 *
 * So it is taken here, once, and travels with the file. A few kilobytes beside
 * something measured in megabytes.
 *
 * Not every browser will hand over a frame - a codec it can record but not
 * decode, a file somebody attached that it cannot play at all - and that is not
 * an error worth a sentence. The list draws its plain frame, exactly as it does
 * for every video sent before this existed.
 */

/** How wide a still is. Wider than a thumbnail is ever drawn, so it still looks
 *  right on a big screen, and far short of the picture itself. */
const WIDTH = 640;

/** How far in to look for a frame. The first frame of a screen recording is
 *  often the moment before anything happened - a blank window, a desktop - so
 *  the still is taken a beat later, where the recording is of something. */
const AT_SECONDS = 0.5;

/** How long to wait for a browser to decode a frame before giving up on it. A
 *  file it cannot play never fires the events this waits on. */
const PATIENCE_MS = 5000;

/** Whether this is something to take a still from at all. */
export function isVideoFile(type: string): boolean {
    const base = (type.split(";")[0] ?? "").trim().toLowerCase();
    return base === "video/mp4" || base === "video/webm" || base === "video/ogg";
}

/**
 * One frame of a video, as a JPEG, or null.
 *
 * JPEG rather than WebP: it is what every browser encodes, every browser draws,
 * and it is a photograph of a screen - the format's own weakness, sharp text,
 * is worth the compatibility at thumbnail size.
 */
export async function posterFor(file: File): Promise<Blob | null> {
    if (typeof document === "undefined" || !isVideoFile(file.type)) return null;

    const address = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = address;

    try {
        return await new Promise<Blob | null>((resolve) => {
            const done = (blob: Blob | null) => {
                clearTimeout(timer);
                video.removeAttribute("src");
                video.load();
                resolve(blob);
            };
            const timer = setTimeout(() => done(null), PATIENCE_MS);

            video.onerror = () => done(null);
            video.onloadeddata = () => {
                // A recording made in a browser has no duration in its
                // container, so seeking into it is a request the browser cannot
                // answer: the frame already loaded is the one to take.
                const length = Number.isFinite(video.duration) ? video.duration : 0;
                if (length > AT_SECONDS) {
                    video.onseeked = () => done(draw(video));
                    video.currentTime = AT_SECONDS;
                    return;
                }
                done(draw(video));
            };
        });
    } finally {
        URL.revokeObjectURL(address);
    }
}

/** Whatever the element is showing, at thumbnail size. */
function draw(video: HTMLVideoElement): Blob | null {
    const width = Math.min(video.videoWidth || WIDTH, WIDTH);
    const height = Math.round(width * ((video.videoHeight || 9) / (video.videoWidth || 16)));
    if (!width || !height) return null;

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) return null;
    context.drawImage(video, 0, 0, width, height);

    // Synchronous, because the promise above has already resolved by the time an
    // async `toBlob` would answer - and a data URL is a string this would then
    // have to turn back into bytes.
    const data = canvas.toDataURL("image/jpeg", 0.7);
    const comma = data.indexOf(",");
    if (comma < 0) return null;
    const binary = atob(data.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) bytes[at] = binary.charCodeAt(at);
    return new Blob([bytes], { type: "image/jpeg" });
}
