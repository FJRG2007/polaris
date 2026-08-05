/**
 * Whether the servers Drive borrows as SFTP sources are answering.
 *
 * Every registered server shows up in Drive as a source, and one that is off
 * answers a browse with a connect timeout and then a generic failure - after
 * holding the request open for it. This is the same TCP probe the Servers app
 * runs, keyed by the source id Drive uses, so the explorer can say the machine
 * is down instead of trying it. Saved connections (a NAS, a cloud) are not
 * probed here: their reachability is the driver's business, not a server's.
 *
 * A denial answers 403 rather than redirecting the way a page does: this is
 * fetched, and a redirect would arrive at the caller as HTML where it expected
 * JSON. Node runtime: the probe opens sockets.
 */

import { LOCAL_SERVER_ID } from "@/lib/local-server";
import { serverStatuses } from "@/lib/server-status";
import { requireUser, sessionCan } from "@/lib/session";
import { HOST_CONNECTION_PREFIX } from "@/lib/storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await requireUser();
    if (!user.isAdmin && !(await sessionCan(user, "drive.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    // The local box is the machine serving this request, and it is not a source
    // in the rail either - only registered servers are.
    const sources = (await serverStatuses(user.id))
        .filter((status) => status.id !== LOCAL_SERVER_ID)
        .map((status) => ({
            id: `${HOST_CONNECTION_PREFIX}${status.id}`,
            state: status.state,
            detail: status.detail
        }));
    return Response.json({ sources });
}
