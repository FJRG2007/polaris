/**
 * Public share delete. Removes an item WITHIN the shared subtree - the token is
 * the credential, gated exactly like the download route, and the share must have
 * `allowDelete`. The path is resolved inside the subtree so nothing outside it can
 * be touched, and the shared root itself can never be deleted (that would destroy
 * the share's own target). The delete is permanent (a public share has no recycle
 * bin), so this is only ever reachable when the owner explicitly enabled it. Node
 * runtime for the drivers.
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
    const gate = await gateShareRequest(token, "delete");
    if (!gate.ok) return new Response(gate.reason, { status: gate.status });

    const { share, ip, ipHash, userAgentHash } = gate;
    if (!share.allowDelete) return new Response("delete_disabled", { status: 403 });

    let body: { path?: unknown };
    try {
        body = await request.json();
    } catch {
        return new Response("invalid_body", { status: 400 });
    }
    if (typeof body.path !== "string") return new Response("missing_path", { status: 400 });

    const root = normalizeRelPath(share.path);
    const target = resolveWithinShare(share.path, body.path);
    if (target === null) return new Response("path_outside_share", { status: 400 });
    if (target === root) return new Response("cannot_delete_root", { status: 400 });

    const driver = await getDriverForConnection(share.connectionId);
    try {
        await driver.delete(target, { recursive: true });
        void logShareAccess({ shareId: share.id, action: "delete", ip, ipHash, userAgentHash });
        return Response.json({ ok: true });
    } catch (error) {
        console.error("share: delete failed", error);
        return new Response("delete_failed", { status: 500 });
    } finally {
        await driver.dispose();
    }
}
