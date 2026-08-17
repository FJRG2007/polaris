/**
 * One frame from a camera, as a picture.
 *
 * What the wall draws before anybody presses play, and what a tile falls back to
 * when a viewer stops watching. Node runtime: it reads the database and dials the
 * relay.
 */

import { homeInstall } from "@/lib/home/access";
import { requireUser, sessionCan } from "@/lib/session";
import { cameraStill, CameraOfflineError } from "@/lib/home/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const user = await requireUser();
    if (!(await sessionCan(user, "home.read"))) return new Response("Forbidden", { status: 403 });
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });

    const { id } = await context.params;
    try {
        const image = await cameraStill(install.id, id);
        return new Response(new Uint8Array(image), {
            headers: {
                "content-type": "image/jpeg",
                // A still is worth a few seconds: a wall of tiles refreshing on a
                // timer should not ask the relay twelve times a second, and a
                // picture from ten seconds ago is not what anybody wants either.
                "cache-control": "private, max-age=5"
            }
        });
    } catch (caught) {
        // A camera that is asleep, starting, or off is not a server fault, and the
        // tile that asked has its own way of saying so.
        if (caught instanceof CameraOfflineError) return new Response(caught.message, { status: 503 });
        throw caught;
    }
}
