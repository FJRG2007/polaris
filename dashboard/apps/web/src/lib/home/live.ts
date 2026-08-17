/**
 * Getting a camera onto somebody's screen.
 *
 * Everything a viewer sees goes through Polaris, never straight to the camera or
 * even to the relay: the relay is a media server with an API that can be told to
 * read files, and it lives on somebody's home network. So the browser is given a
 * Polaris URL, this resolves it, and the bytes are passed through. A viewer never
 * learns the camera's address, its password, or where the relay is.
 *
 * Not WebRTC. It would shave a second off the delay and it cannot work here: its
 * media goes direct from the relay to the browser over UDP, which means opening
 * the relay to viewers - exactly what the paragraph above refuses.
 *
 * So there are two transports, and which one a browser gets is not a preference.
 * A progressive fragmented MP4 is the good one: one request, no player library,
 * about a second behind. No Apple device can play it - not Safari on a Mac, not
 * an iPhone, not an iPad, and not Chrome on either of them, because they are all
 * the same engine. Those get HLS, which is a playlist of small segments, several
 * seconds behind, and the only thing they will play. Both come down the same
 * authenticated path, so both work from outside the house.
 *
 * Server-only.
 */

import { getCamera } from "@/lib/home/cameras";
import {
    relayEndpoint,
    relayServerFor,
    snapshot,
    streamPath,
    relayStream,
    hlsMasterPath,
    hlsAssetPath,
    type HlsFile,
    type RelayEndpoint
} from "@/lib/home/relay";

export class CameraOfflineError extends Error {}

/**
 * The relay's cache window when one camera is being watched by itself.
 *
 * Only reached while the stream is not playing - a picture is what carries the
 * view until the video starts, and what carries it altogether when the video
 * will not start at all. Four a second is not video and does not pretend to be;
 * it is the difference between a view somebody can follow and one that reads as
 * broken.
 */
const SMOOTH_CACHE_MS = 250;

/** The relay serving one camera, or a refusal that says which of the two things
 *  went wrong - there is no relay yet, or there is one and it is not answering. */
async function relayForCamera(installedAppId: string, cameraId: string): Promise<{ endpoint: RelayEndpoint; cameraId: string }> {
    const camera = await getCamera(installedAppId, cameraId);
    if (!camera) throw new CameraOfflineError("No such camera");
    if (!camera.enabled) throw new CameraOfflineError("This camera is switched off");
    const endpoint = await relayEndpoint(relayServerFor(camera.reachVia));
    if (!endpoint) throw new CameraOfflineError("The camera relay is still starting");
    return { endpoint, cameraId: camera.id };
}

/** A still, for the wall and for an event's picture. The small stream on purpose:
 *  a wall of twelve full-resolution stills is several megabytes to draw a page
 *  nobody is looking closely at yet. */
export async function cameraStill(
    installedAppId: string,
    cameraId: string,
    options: { width?: number; smooth?: boolean; signal?: AbortSignal } = {}
): Promise<Buffer> {
    const { endpoint } = await relayForCamera(installedAppId, cameraId);
    const image = await snapshot(endpoint, cameraId, "sub", {
        ...(options.width ? { width: options.width } : {}),
        // A second by default. It is what makes a wall of tiles refreshing
        // together cost one decode per camera rather than one per tile, and a
        // picture up to a second old is not one anybody can tell from the live
        // one when it is a postcard among eleven others.
        //
        // It is also a hard ceiling on how many different pictures anybody can
        // be shown, and that is the whole of what "it looks like frames rather
        // than video" means. So one camera being watched on its own asks for
        // less: nothing else is competing for the relay, and the difference
        // between one picture a second and four is the difference between a
        // slideshow and something a person reads as moving.
        cacheMs: options.smooth ? SMOOTH_CACHE_MS : 1000,
        ...(options.signal ? { signal: options.signal } : {})
    });
    if (!image) throw new CameraOfflineError("The camera did not send a picture");
    return image;
}

/**
 * The live stream, as a response ready to be passed straight through.
 *
 * `quality` is the viewer's choice: the wall watches the small stream so twelve
 * of them cost what one does, and opening one camera switches to the good one.
 */
export async function cameraStream(
    installedAppId: string,
    cameraId: string,
    quality: "main" | "sub",
    signal?: AbortSignal
): Promise<Response> {
    const { endpoint } = await relayForCamera(installedAppId, cameraId);
    const upstream = await relayStream(endpoint, streamPath(cameraId, "mp4", quality), signal ? { signal } : undefined);
    if (!upstream.ok || !upstream.body) throw new CameraOfflineError("The camera is not answering");
    return new Response(upstream.body, {
        headers: {
            "content-type": upstream.headers.get("content-type") ?? "video/mp4",
            // Live video is never the same twice, and a cached first fragment is
            // a player that shows a frame from this morning and then stalls.
            "cache-control": "no-store",
            // The stream is generated as it is watched, so there is no length and
            // no seeking. Saying so stops a browser asking for ranges of it.
            "accept-ranges": "none"
        }
    });
}

/**
 * Point the master playlist at this route instead of at the relay.
 *
 * go2rtc writes one relative link, `hls/playlist.m3u8?id=...`, which is right
 * when the playlist is served from `api/stream.m3u8` and one directory too deep
 * from ours. Dropping the prefix makes it a sibling, and every link below it -
 * the init segment and the media segments - is then already relative to the
 * right place and needs no touching.
 *
 * Exported for its own test: this is one substitution standing between a viewer
 * and a black rectangle, and it is worth pinning.
 */
export function rewriteMasterPlaylist(playlist: string): string {
    return playlist.replace(/(^|\n)hls\/playlist\.m3u8\?/g, "$1playlist.m3u8?");
}

/** A session id as go2rtc mints them, and the sequence number a player asks for.
 *  Anything else is not a request this proxy makes on somebody's behalf. */
const SESSION = /^[A-Za-z0-9]{1,32}$/;
const SEQUENCE = /^[0-9]{1,12}$/;

/**
 * The same live stream, as HLS, for the browsers that will not take the MP4.
 *
 * Every file a player asks for comes back through here, so the relay stays
 * unreachable and a viewer outside the house needs nothing open but Polaris.
 */
export async function cameraHls(
    installedAppId: string,
    cameraId: string,
    file: HlsFile,
    query: { quality: "main" | "sub"; session: string | null; sequence: string | null },
    signal?: AbortSignal
): Promise<Response> {
    const { endpoint } = await relayForCamera(installedAppId, cameraId);
    const passthrough = signal ? { signal } : undefined;

    if (file === "stream.m3u8") {
        const upstream = await relayStream(endpoint, hlsMasterPath(cameraId, query.quality), passthrough);
        if (!upstream.ok) throw new CameraOfflineError("The camera is not answering");
        return playlist(rewriteMasterPlaylist(await upstream.text()));
    }

    // A player only ever asks for these with a session the relay gave it a moment
    // ago. One that does not look like one is not worth dialling out for.
    if (!query.session || !SESSION.test(query.session)) throw new CameraOfflineError("That stream has ended");
    if (query.sequence && !SEQUENCE.test(query.sequence)) throw new CameraOfflineError("That stream has ended");

    const upstream = await relayStream(endpoint, hlsAssetPath(file, query.session, query.sequence), passthrough);
    // A segment the relay no longer holds is an ordinary part of live HLS: the
    // player asks again. Passing the status through is what lets it.
    if (!upstream.ok) return new Response(null, { status: upstream.status === 404 ? 404 : 503 });
    if (file === "playlist.m3u8") return playlist(await upstream.text());
    return new Response(upstream.body, {
        headers: {
            "content-type": upstream.headers.get("content-type") ?? "video/iso.segment",
            "cache-control": "no-store"
        }
    });
}

function playlist(body: string): Response {
    return new Response(body, {
        headers: {
            "content-type": "application/vnd.apple.mpegurl",
            // A playlist that is a few seconds old points at segments the relay
            // has already dropped, which a player reports as a stall.
            "cache-control": "no-store"
        }
    });
}
