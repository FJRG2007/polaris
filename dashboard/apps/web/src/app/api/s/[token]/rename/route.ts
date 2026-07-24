/**
 * Public share rename/move. Moves an item to a new name or location WITHIN the
 * shared subtree - the token is the credential, gated exactly like the download
 * route, and the share must have `allowRename`. Both the source and destination
 * are resolved inside the subtree so nothing can be moved in or out of it, and the
 * shared root itself can never be renamed (that would move the share's own target).
 * Node runtime for the drivers.
 */

import { normalizeRelPath } from "@polaris/core";
import { getDriverForConnection } from "@/lib/storage-service";
import { logShareAccess, resolveWithinShare } from "@/lib/share-service";
import { gateShareRequest } from "@/lib/share-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const gate = await gateShareRequest(token, "rename");
    if (!gate.ok) return new Response(gate.reason, { status: gate.status });

    const { share, ip, ipHash, userAgentHash } = gate;
    if (!share.allowRename) return new Response("rename_disabled", { status: 403 });

    let body: { from?: unknown; to?: unknown };
    try {
        body = await request.json();
    } catch {
        return new Response("invalid_body", { status: 400 });
    }
    if (typeof body.from !== "string" || typeof body.to !== "string") {
        return new Response("missing_paths", { status: 400 });
    }

    const root = normalizeRelPath(share.path);
    const from = resolveWithinShare(share.path, body.from);
    const to = resolveWithinShare(share.path, body.to);
    if (from === null || to === null) return new Response("path_outside_share", { status: 400 });
    // The shared root is the share's own target; renaming it would break the share.
    if (from === root || to === root) return new Response("cannot_rename_root", { status: 400 });

    const driver = await getDriverForConnection(share.connectionId);
    try {
        await driver.move(from, to);
        void logShareAccess({ shareId: share.id, action: "rename", ip, ipHash, userAgentHash });
        return Response.json({ ok: true });
    } catch (error) {
        console.error("share: rename failed", error);
        return new Response("rename_failed", { status: 500 });
    } finally {
        await driver.dispose();
    }
}
