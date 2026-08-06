/**
 * Whether the sources in Drive's rail are answering.
 *
 * Any source can be a machine that is off - a registered server, a NAS, a UNAS -
 * and one that is off holds a browse open for its connect timeout before failing
 * with something that names nothing. The explorer asks this first so it can say
 * the device is down instead of trying it. What is probed, and on which port, is
 * decided in the source-status module.
 *
 * A denial answers 403 rather than redirecting the way a page does: this is
 * fetched, and a redirect would arrive at the caller as HTML where it expected
 * JSON. Node runtime: the probe opens sockets.
 */

import { requireUser, sessionCan } from "@/lib/session";
import { driveSourceStatuses } from "@/lib/drive-source-status";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await requireUser();
    if (!user.isAdmin && !(await sessionCan(user, "drive.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    return Response.json({ sources: await driveSourceStatuses(user.id) });
}
