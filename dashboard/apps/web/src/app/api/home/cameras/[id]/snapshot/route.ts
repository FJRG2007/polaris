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

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const user = await requireUser();
    if (!(await sessionCan(user, "home.read"))) return new Response("Forbidden", { status: 403 });
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });

    const { id } = await context.params;
    // The size it will actually be drawn at. A tile is a few hundred pixels wide
    // and a camera's own frame is several thousand: sending the full one is most
    // of a megabyte, several times a second, to fill a postcard.
    const asked = Number(new URL(request.url).searchParams.get("w"));
    const width = Number.isFinite(asked) && asked >= 160 && asked <= 1920 ? Math.round(asked) : undefined;
    try {
        const image = await cameraStill(install.id, id, {
            ...(width ? { width } : {}),
            // Somebody who closed the tab is not owed a decoded frame.
            signal: request.signal
        });
        return new Response(new Uint8Array(image), {
            headers: {
                "content-type": "image/jpeg",
                // Not cached by the browser: the wall asks for a new one on a
                // timer and a cached answer is a picture that never changes,
                // which is the whole complaint. Sharing the cost between tiles is
                // the relay's job, and it does it with its own one-second window.
                "cache-control": "no-store"
            }
        });
    } catch (caught) {
        // A camera that is asleep, starting, or off is not a server fault, and the
        // tile that asked has its own way of saying so.
        if (caught instanceof CameraOfflineError) return new Response(caught.message, { status: 503 });
        throw caught;
    }
}
