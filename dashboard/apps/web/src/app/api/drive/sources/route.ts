/**
 * The storages this reader can reach, for a picker to offer.
 *
 * The Drive screen resolves the same set on the server when it renders. A file
 * picker cannot: it is opened from a composer, a comment box, a form - screens
 * that have no business knowing what a storage connection is - so it asks for
 * the list when it opens.
 *
 * Names and nothing else. What is IN a storage still goes through the listing
 * route and its own authorization on every folder.
 */

import { apiUser } from "@/lib/api-session";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import { sessionCan } from "@/lib/session";
import { listAccessibleConnections } from "@/lib/storage-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!(await sessionCan(user, "drive.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const connections = await listAccessibleConnections(user.id, await scopeOrgIdFor(user.id));
    return Response.json(
        {
            sources: connections.map((one) => ({
                id: one.id,
                name: one.name,
                shared: Boolean((one as { shared?: boolean }).shared),
                rootPath: (one as { rootPath?: string }).rootPath ?? ""
            }))
        },
        { headers: { "cache-control": "no-store" } }
    );
}
