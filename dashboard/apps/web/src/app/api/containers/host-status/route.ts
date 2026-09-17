/**
 * Whether the servers in Containers' host list are answering.
 *
 * A registered server that is off holds a container listing open for its SSH
 * connect timeout and then fails with a message that names nothing. The list asks
 * this first, so a server that is down is marked and not opened. The same probe
 * the Servers screen uses, answered for the caller's own servers only.
 *
 * A denial answers 403 rather than redirecting the way a page does: this is
 * fetched, and a redirect would arrive at the caller as HTML where it expected
 * JSON. Node runtime: the probe opens sockets.
 */

import { sessionCan } from "@/lib/session";
import { apiUser } from "@/lib/api-session";
import { serverStatuses } from "@/lib/server-status";
import { LOCAL_SERVER_ID } from "@/lib/local-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!user.isAdmin && !(await sessionCan(user, "deploy.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    // Only what can be off: the local box is the machine answering this request.
    const servers = (await serverStatuses(user.id)).filter(
        (server) => server.id !== LOCAL_SERVER_ID
    );
    return Response.json({ servers });
}
