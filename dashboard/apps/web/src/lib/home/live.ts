/**
 * Getting a camera onto somebody's screen.
 *
 * Everything a viewer sees goes through Polaris, never straight to the camera or
 * even to the relay: the relay is a media server with an API that can be told to
 * read files, and it lives on somebody's home network. So the browser is given a
 * Polaris URL, this resolves it, and the bytes are passed through. A viewer never
 * learns the camera's address, its password, or where the relay is.
 *
 * The transport is a progressive fragmented MP4 rather than WebRTC. WebRTC would
 * shave a second off the delay, and it cannot work here: its media goes direct
 * from the relay to the browser over UDP, which means opening the relay to
 * viewers - exactly what the paragraph above refuses. An MP4 over HTTP plays in
 * every browser with no player library, arrives about a second behind, and
 * travels the one path that is already authenticated.
 *
 * Server-only.
 */

import { getCamera } from "@/lib/home/cameras";
import { relayEndpoint, relayServerFor, snapshot, streamPath, relayStream, type RelayEndpoint } from "@/lib/home/relay";

export class CameraOfflineError extends Error {}

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
export async function cameraStill(installedAppId: string, cameraId: string): Promise<Buffer> {
    const { endpoint } = await relayForCamera(installedAppId, cameraId);
    const image = await snapshot(endpoint, cameraId, "sub");
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
    quality: "main" | "sub"
): Promise<Response> {
    const { endpoint } = await relayForCamera(installedAppId, cameraId);
    const upstream = await relayStream(endpoint, streamPath(cameraId, "mp4", quality));
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
