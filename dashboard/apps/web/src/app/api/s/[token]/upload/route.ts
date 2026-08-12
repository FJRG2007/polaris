/**
 * Public share upload (drop box). Streams the request body into the shared folder
 * with no session - the token is the credential, gated exactly like the download
 * route, and the share must have `allowUpload`. The destination is resolved inside
 * the shared subtree so a request can never write outside it, and parent folders
 * are created as needed. Node runtime because the drivers need it; Server Actions
 * are avoided here because they buffer the body.
 */

import { claimUploadPath, replaceWithStaged } from "@/lib/upload-naming";
import { gateShareRequest } from "@/lib/share-access";
import { baseName, normalizeRelPath } from "@polaris/core";
import { getDriverForConnection } from "@/lib/storage-service";
import { invalidateFolderSizes } from "@/lib/drive-folder-size";
import { logShareAccess, resolveWithinShare } from "@/lib/share-service";

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
        // Uploading is not permission to destroy: whoever holds this link cannot see
        // the folder, so a name that collides is somebody else's file, not a version
        // of their own. The name is claimed before the transfer and a collision is
        // numbered, unless the owner explicitly allowed replacing what is there.
        const staged = await claimUploadPath(driver, target);
        const destination = share.allowOverwrite ? target : staged;
        let stat;
        try {
            stat = await driver.writeStream(staged, request.body);
        } catch (error) {
            // A failed transfer leaves no half-written file behind under a name that
            // reads as a complete document. The file it was going to replace is
            // untouched: nothing moves onto it until the bytes are all here.
            await driver.delete(staged).catch(() => undefined);
            throw error;
        }
        await replaceWithStaged(driver, staged, destination);
        await invalidateFolderSizes(share.connectionId, destination);
        void logShareAccess({ shareId: share.id, action: "upload", ip, ipHash, userAgentHash });
        return Response.json({
            ok: true,
            path: stat.path,
            name: baseName(destination),
            size: stat.size.toString()
        });
    } catch (error) {
        console.error("share: upload failed", error);
        return new Response("upload_failed", { status: 500 });
    } finally {
        await driver.dispose();
    }
}
