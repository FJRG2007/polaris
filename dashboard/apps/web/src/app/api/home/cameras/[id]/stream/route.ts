/**
 * A camera, live, as video a browser can play on its own.
 *
 * The bytes come from the relay and are passed through without being held, so
 * watching costs Polaris a socket and no memory. `q=main` is the good stream and
 * is what opening one camera asks for; the wall asks for the small one.
 */

import { homeInstall } from "@/lib/home/access";
import { requireUser, sessionCan } from "@/lib/session";
import { cameraStream, CameraOfflineError } from "@/lib/home/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
    const user = await requireUser();
    if (!(await sessionCan(user, "home.read"))) return new Response("Forbidden", { status: 403 });
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });

    const { id } = await context.params;
    const quality = new URL(request.url).searchParams.get("q") === "sub" ? "sub" : "main";
    try {
        return await cameraStream(install.id, id, quality);
    } catch (caught) {
        if (caught instanceof CameraOfflineError) return new Response(caught.message, { status: 503 });
        throw caught;
    }
}
