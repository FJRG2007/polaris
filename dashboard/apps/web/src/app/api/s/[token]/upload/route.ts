/**
 * Public share upload (drop box). Streams the request body into the shared folder
 * with no session - the token is the credential, gated exactly like the download
 * route, and the share must have `allowUpload`. The destination is resolved inside
 * the shared subtree so a request can never write outside it, and parent folders
 * are created as needed. Node runtime because the drivers need it; Server Actions
 * are avoided here because they buffer the body.
 */

import { normalizeRelPath } from "@polaris/core";
import { getDriverForConnection } from "@/lib/storage-service";
import { logShareAccess, resolveWithinShare } from "@/lib/share-service";
import { gateShareRequest } from "@/lib/share-access";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const gate = await gateShareRequest(token, "upload");
    if (!gate.ok) return new Response(gate.reason, { status: gate.status });

    const { share, ip, ipHash, userAgentHash } = gate;
    if (!share.allowUpload) return new Response("uploads_disabled", { status: 403 });
    if (!request.body) return new Response("empty_body", { status: 400 });

    const url = new URL(request.url);
    const rawPath = url.searchParams.get("p") ?? "";
    const name = url.searchParams.get("name");
    if (!name) return new Response("missing_name", { status: 400 });

    let target: string;
    try {
        target = normalizeRelPath(rawPath ? `${rawPath}/${name}` : name);
    } catch {
        return new Response("invalid_path", { status: 400 });
    }
    // The destination (and thus its parents) must stay inside the shared subtree.
    if (resolveWithinShare(share.path, target) === null) {
        return new Response("path_outside_share", { status: 400 });
    }

    const driver = await getDriverForConnection(share.connectionId);
    try {
        // A folder upload sends nested names (a/b/file.txt); ensure the parent dirs
        // exist before writing. mkdir on an existing dir is ignored.
        const segments = target.split("/");
        segments.pop();
        let dir = "";
        for (const segment of segments) {
            dir = dir ? `${dir}/${segment}` : segment;
            try {
                await driver.mkdir(dir);
            } catch {
                // Already exists (or the driver made it implicitly); keep going.
            }
        }
        const stat = await driver.writeStream(target, request.body);
        void logShareAccess({ shareId: share.id, action: "upload", ip, ipHash, userAgentHash });
        return Response.json({ ok: true, path: stat.path, size: stat.size.toString() });
    } catch (error) {
        console.error("share: upload failed", error);
        return new Response("upload_failed", { status: 500 });
    } finally {
        await driver.dispose();
    }
}
