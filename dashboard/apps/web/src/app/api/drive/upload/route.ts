/**
 * Streaming upload. The request body is piped straight into the connection's
 * driver, so an arbitrarily large file never lands in memory. An optional offset
 * query resumes an interrupted upload on drivers that support random writes.
 * Node runtime; Server Actions are avoided here because they buffer the body.
 */

import { normalizeRelPath, parentPath } from "@polaris/core";
import { apiUser } from "@/lib/api-session";
import { sessionCan } from "@/lib/session";
import { requireDriveDriver, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import { recordItemCreator } from "@/lib/drive-meta-service";
import { invalidateFolderSizes } from "@/lib/drive-folder-size";
import { recordAudit } from "@/lib/audit-service";
import { prisma } from "@polaris/db";
import { storageRefusal } from "@/lib/storage-refusal";
import { isUnreachable, StorageRefused } from "@/lib/storage-target";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PUT(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!(await sessionCan(user, "drive.write"))) {
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
        // That is the folder the normalized target sits in, not the `p` the caller
        // named: a `name` carrying `../` or a nested path moves the write out of
        // `p`, past the access rules and locks that were checked there.
        driver = await requireDriveDriver(user.id, connectionId, parentPath(target), "write");
    } catch (caught) {
        if (caught instanceof DriveLockedError) return new Response("Locked", { status: 423 });
        if (caught instanceof DriveAccessError) return new Response("Forbidden", { status: 403 });
        // The location would not open - a NAS that is off is the usual one. Said
        // by its name rather than as the framework's bare 500, which is all the
        // uploader used to get.
        console.error("drive: upload could not open the location:", caught);
        return unreachable(connectionId, caught, user.isAdmin);
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
        await invalidateFolderSizes(connectionId, target);
        await recordAudit({
            actorId: user.id,
            action: "drive.upload",
            targetType: "connection",
            targetId: connectionId,
            metadata: { path: target, size: stat.size.toString() }
        });
        return Response.json({ ok: true, path: stat.path, size: stat.size.toString() });
    } catch (error) {
        if (isUnreachable(error)) {
            console.error("drive: upload stopped, the location went away:", error);
            return unreachable(connectionId, error, user.isAdmin);
        }
        return new Response(error instanceof Error ? error.message : "Upload failed", {
            status: 500
        });
    } finally {
        await driver.dispose();
    }
}

/** A location that is not answering, by the name its owner gave it. */
async function unreachable(
    connectionId: string,
    error: unknown,
    isAdmin: boolean
): Promise<Response> {
    const named = await prisma.storageConnection
        .findUnique({ where: { id: connectionId }, select: { name: true } })
        .catch(() => null);
    const said = new StorageRefused(
        error instanceof Error ? error.message : String(error),
        named?.name ?? null,
        isUnreachable(error),
        { cause: error }
    );
    return new Response(await storageRefusal(said, isAdmin), {
        status: said.unreachable ? 503 : 502
    });
}
