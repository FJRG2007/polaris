/**
 * Public share create-folder. Creates a folder WITHIN the shared subtree - the
 * token is the credential, gated exactly like the download route, and the share
 * must have `allowCreateFolder`. The destination is resolved inside the subtree so
 * nothing can be created outside it. Node runtime for the drivers.
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
    const gate = await gateShareRequest(token, "mkdir");
    if (!gate.ok) return new Response(gate.reason, { status: gate.status });

    const { share, ip, ipHash, userAgentHash } = gate;
    if (!share.allowCreateFolder) return new Response("create_folder_disabled", { status: 403 });

    let body: { parent?: unknown; name?: unknown };
    try {
        body = await request.json();
    } catch {
        return new Response("invalid_body", { status: 400 });
    }
    if (typeof body.name !== "string" || !body.name.trim()) {
        return new Response("missing_name", { status: 400 });
    }
    const parent = typeof body.parent === "string" ? body.parent : "";

    let target: string;
    try {
        target = normalizeRelPath(parent ? `${parent}/${body.name}` : body.name);
    } catch {
        return new Response("invalid_path", { status: 400 });
    }
    if (resolveWithinShare(share.path, target) === null) {
        return new Response("path_outside_share", { status: 400 });
    }

    const driver = await getDriverForConnection(share.connectionId);
    try {
        await driver.mkdir(target);
        void logShareAccess({ shareId: share.id, action: "mkdir", ip, ipHash, userAgentHash });
        return Response.json({ ok: true });
    } catch (error) {
        console.error("share: mkdir failed", error);
        return new Response("mkdir_failed", { status: 500 });
    } finally {
        await driver.dispose();
    }
}
