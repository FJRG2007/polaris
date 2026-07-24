/**
 * Public share listing. Serves a folder's contents for a folder share with no
 * session - the token is the credential, gated exactly like the download route.
 * The requested path must stay inside the shared subtree, and Polaris's own
 * reserved folders (trash, quarantine) are never listed. Only the presentational
 * fields a public visitor needs are returned - no owner names, notes, or other
 * per-user metadata leaks through a link. Node runtime for Prisma and the drivers.
 */

import { getDriverForConnection } from "@/lib/storage-service";
import { resolveWithinShare } from "@/lib/share-service";
import { gateShareRequest } from "@/lib/share-access";
import { isReservedRootPath } from "@/lib/system-paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const gate = await gateShareRequest(token, "list");
    if (!gate.ok) return Response.json({ error: gate.reason }, { status: gate.status });

    const requested = new URL(request.url).searchParams.get("p");
    const target = resolveWithinShare(gate.share.path, requested);
    if (target === null) return Response.json({ error: "path_outside_share" }, { status: 400 });

    const driver = await getDriverForConnection(gate.share.connectionId);
    try {
        const stat = await driver.stat(target);
        if (stat.kind !== "dir") return Response.json({ error: "not_a_folder" }, { status: 400 });

        const listing = await driver.list(target);
        const entries = listing.entries
            .filter((entry) => !isReservedRootPath(entry.path))
            .map((entry) => ({
                name: entry.name,
                path: entry.path,
                kind: entry.kind,
                size: entry.size.toString(),
                modifiedAt: entry.modifiedAt.toISOString(),
                createdAt: (entry.createdAt ?? entry.modifiedAt).toISOString()
            }));
        return Response.json({ entries });
    } catch (caught) {
        // Log the real cause server-side; the client only sees a generic message.
        console.error("share: list failed", caught);
        return Response.json({ error: "list_failed" }, { status: 502 });
    } finally {
        await driver.dispose();
    }
}
