/**
 * Reachability and latency for every server, plus the local machine's own name.
 *
 * Both are round trips - a TCP handshake per server, and a call into the
 * container engine for the name - so they are served here and folded into the
 * page after it has painted, rather than held in front of the server render.
 *
 * A denial answers 403 rather than redirecting the way a page does: this is
 * fetched, and a redirect would arrive at the caller as a page of HTML where it
 * expected JSON. Node runtime: the probe opens sockets.
 */

import { sessionCan } from "@/lib/session";
import { apiUser } from "@/lib/api-session";
import { serverStatuses } from "@/lib/server-status";
import { localMachineName } from "@/lib/local-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!user.isAdmin && !(await sessionCan(user, "system.manage"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const [servers, machineName] = await Promise.all([serverStatuses(user.id), localMachineName()]);
    return Response.json({ servers, machineName });
}
