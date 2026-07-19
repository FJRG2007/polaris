/**
 * Streaming upload. The request body is piped straight into the connection's
 * driver, so an arbitrarily large file never lands in memory. An optional offset
 * query resumes an interrupted upload on drivers that support random writes.
 * Node runtime; Server Actions are avoided here because they buffer the body.
 */

import { normalizeRelPath } from "@polaris/core";
import { userHasPermission } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { requireDriveDriver, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import { recordItemCreator } from "@/lib/drive-meta-service";
import { recordAudit } from "@/lib/audit-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.write"))) {
        return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("c");
    const rawPath = url.searchParams.get("p") ?? "";
    const name = url.searchParams.get("name");
    const offsetParam = url.searchParams.get("offset");
    if (!connectionId || !name) return new Response("Missing parameters", { status: 400 });
    if (!request.body) return new Response("Empty body", { status: 400 });

    let target: string;
    try {
        target = normalizeRelPath(rawPath ? `${rawPath}/${name}` : name);
    } catch {
        return new Response("Invalid path", { status: 400 });
    }

    const offset = offsetParam ? Number(offsetParam) : undefined;
    let driver;
    try {
        // Authorize against the destination folder (the parent), where the write lands.
        driver = await requireDriveDriver(user.id, connectionId, rawPath, "write");
    } catch (caught) {
        if (caught instanceof DriveLockedError) return new Response("Locked", { status: 423 });
        if (caught instanceof DriveAccessError) return new Response("Forbidden", { status: 403 });
        throw caught;
    }
    try {
        // A folder upload sends nested names (a/b/file.txt); make sure the parent
        // directories exist before writing. mkdir on an existing dir is ignored.
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
        const stat = await driver.writeStream(target, request.body, { offset });
        await recordItemCreator(connectionId, target, user.id);
        await recordAudit({
            actorId: user.id,
            action: "drive.upload",
            targetType: "connection",
            targetId: connectionId,
            metadata: { path: target, size: stat.size.toString() }
        });
        return Response.json({ ok: true, path: stat.path, size: stat.size.toString() });
    } catch (error) {
        return new Response(error instanceof Error ? error.message : "Upload failed", { status: 500 });
    } finally {
        await driver.dispose();
    }
}
