/**
 * One frame from a camera handed out as a link: what the guest page shows
 * before the video starts. Behind the link's check, like the stream.
 */

import { guestWatchCamera } from "../../../../../../../../lib/guest-camera";
import { cameraStill, CameraOfflineError } from "../../../../../../../../lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    context: { params: Promise<{ token: string; watch: string }> }
): Promise<Response> {
    const { token, watch } = await context.params;
    const seen = await guestWatchCamera(String(token), String(watch));
    if (!seen) return new Response("Gone", { status: 410 });
    try {
        const image = await cameraStill(seen.installId, seen.cameraId, {
            width: 960,
            signal: request.signal
        });
        return new Response(new Uint8Array(image), {
            headers: { "content-type": "image/jpeg", "cache-control": "no-store" }
        });
    } catch (caught) {
        if (caught instanceof CameraOfflineError) return new Response("Offline", { status: 503 });
        throw caught;
    }
}
