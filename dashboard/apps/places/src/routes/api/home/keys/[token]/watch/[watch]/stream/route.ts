/**
 * A camera handed out as a link, live, as video a browser plays on its own.
 * The same relay path the app's own stream route takes, behind the link's
 * check (`guestWatchCamera`) instead of an account's (`mayWatchCamera`).
 */

import { guestWatchCamera, whileLinkHolds } from "../../../../../../../../lib/guest-camera";
import { cameraStream, CameraOfflineError } from "../../../../../../../../lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    context: { params: Promise<{ token: string; watch: string }> }
): Promise<Response> {
    const { token, watch } = await context.params;
    const seen = await guestWatchCamera(String(token), String(watch));
    if (!seen) return new Response("Gone", { status: 410 });
    const quality = new URL(request.url).searchParams.get("q") === "sub" ? "sub" : "main";
    try {
        return whileLinkHolds(
            await cameraStream(seen.installId, seen.cameraId, quality, request.signal),
            String(token),
            String(watch)
        );
    } catch (caught) {
        if (caught instanceof CameraOfflineError)
            return new Response("Offline", { status: 503 });
        throw caught;
    }
}
