/**
 * A camera handed out as a link, as HLS for the browsers that will not take
 * the MP4. Every playlist and segment comes through here and is checked
 * against the link each time; none of them spends a use.
 */

import { isHlsFile } from "../../../../../../../../../lib/relay";
import { guestWatchCamera } from "../../../../../../../../../lib/guest-camera";
import { cameraHls, CameraOfflineError } from "../../../../../../../../../lib/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    context: { params: Promise<{ token: string; watch: string; file: string }> }
): Promise<Response> {
    const { token, watch, file } = await context.params;
    const seen = await guestWatchCamera(String(token), String(watch));
    if (!seen) return new Response("Gone", { status: 410 });
    if (!isHlsFile(file)) return new Response("Not found", { status: 404 });
    const query = new URL(request.url).searchParams;
    try {
        return await cameraHls(
            seen.installId,
            seen.cameraId,
            file,
            {
                quality: query.get("q") === "sub" ? "sub" : "main",
                session: query.get("id"),
                sequence: query.get("n")
            },
            request.signal
        );
    } catch (caught) {
        if (caught instanceof CameraOfflineError) return new Response("Offline", { status: 503 });
        throw caught;
    }
}
