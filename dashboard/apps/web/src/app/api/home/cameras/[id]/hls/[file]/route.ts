/**
 * The same camera, in the format Apple devices will play.
 *
 * An iPhone, an iPad and Safari on a Mac cannot play the progressive MP4 the
 * other route serves - none of them, in any version - so they get HLS instead: a
 * playlist and a run of short segments, all fetched through here. One route for
 * every file a player asks for, because they are one stream and they all need the
 * same permission.
 */

import { isHlsFile } from "@/lib/home/relay";
import { homeInstall } from "@/lib/home/access";
import { requireUser, sessionCan } from "@/lib/session";
import { cameraHls, CameraOfflineError } from "@/lib/home/live";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    context: { params: Promise<{ id: string; file: string }> }
): Promise<Response> {
    const user = await requireUser();
    if (!(await sessionCan(user, "home.read"))) return new Response("Forbidden", { status: 403 });
    const install = await homeInstall();
    if (!install) return new Response("Not found", { status: 404 });

    const { id, file } = await context.params;
    if (!isHlsFile(file)) return new Response("Not found", { status: 404 });

    const query = new URL(request.url).searchParams;
    try {
        return await cameraHls(install.id, id, file, {
            quality: query.get("q") === "sub" ? "sub" : "main",
            session: query.get("id"),
            sequence: query.get("n")
        });
    } catch (caught) {
        if (caught instanceof CameraOfflineError) return new Response(caught.message, { status: 503 });
        throw caught;
    }
}
