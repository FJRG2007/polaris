/**
 * UniFi UNAS metrics as JSON, for the client-side metrics view. The underlying
 * fetch opens the UniFi OS system websocket and waits for a snapshot (up to a few
 * seconds), so serving it from a client-cached endpoint - rather than blocking
 * the server render of /drive - is what removes the page-load delay. The client
 * caches the result briefly and revalidates in the background. Node runtime.
 */

import { userHasPermission } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { getUnasMetrics } from "@/lib/storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const connectionId = new URL(request.url).searchParams.get("c");
    if (!connectionId) return Response.json({ error: "Missing connection" }, { status: 400 });

    try {
        const metrics = await getUnasMetrics(connectionId, user.id);
        return Response.json({ metrics });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Unable to reach the UNAS console";
        return Response.json({ error: message }, { status: 502 });
    }
}
