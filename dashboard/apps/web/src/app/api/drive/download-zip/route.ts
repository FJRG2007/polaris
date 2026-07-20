/**
 * Bundle several Drive items (files and/or whole folders) into one streaming ZIP.
 * The client requests it with one `p` per selected path; a single file streams
 * directly through the normal download route, so this endpoint always represents
 * a multi-item or folder download. Each requested path is authorized for download
 * on its own (ownership or ACL), locked subtrees are never descended into, and
 * the trash folder is skipped - the same gates as browsing and search. Bytes flow
 * from the driver into the archive without buffering. Node runtime for the driver.
 */

import { normalizeRelPath } from "@polaris/core";
import { userHasPermission } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { getDriverForConnection, SmbShareRequiredError } from "@/lib/storage-service";
import { authorizeDrive, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import { listLocks } from "@/lib/access-lock-service";
import { recordAudit } from "@/lib/audit-service";
import { createZipStream, type ZipSource } from "@/lib/zip-stream";
import { baseNameOf, zipSourcesFor } from "@/lib/drive-archive";
import type { StorageDriver } from "@polaris/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Turn a filename into a safe ASCII fallback for the Content-Disposition header. */
function asciiFallback(name: string): string {
    return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "download";
}

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.read"))) {
        return new Response("Forbidden", { status: 403 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("c");
    if (!connectionId) return new Response("Missing connection", { status: 400 });

    let paths: string[];
    try {
        paths = url.searchParams
            .getAll("p")
            .map((raw) => normalizeRelPath(raw))
            .filter((path) => path.length > 0);
    } catch {
        return new Response("Invalid path", { status: 400 });
    }
    if (paths.length === 0) return new Response("Nothing to download", { status: 400 });

    // Authorize every selected path for download before opening anything.
    for (const path of paths) {
        try {
            await authorizeDrive(user.id, connectionId, path, "download");
        } catch (caught) {
            if (caught instanceof DriveLockedError) return new Response("Locked", { status: 423 });
            if (caught instanceof DriveAccessError) return new Response("Forbidden", { status: 403 });
            throw caught;
        }
    }

    let driver: StorageDriver;
    try {
        driver = await getDriverForConnection(connectionId);
    } catch (caught) {
        if (caught instanceof SmbShareRequiredError) return new Response("Share required", { status: 409 });
        const message = caught instanceof Error ? caught.message : "Unable to connect";
        return new Response(message, { status: 502 });
    }

    const lockedRoots = new Set((await listLocks(connectionId)).map((lock) => lock.path).filter(Boolean));

    async function* sources(): AsyncGenerator<ZipSource> {
        try {
            yield* zipSourcesFor(driver, paths, lockedRoots);
        } finally {
            await driver.dispose();
        }
    }

    await recordAudit({
        actorId: user.id,
        action: "drive.download.zip",
        targetType: "connection",
        targetId: connectionId,
        metadata: { paths: paths.join(", ") }
    });

    const archiveName = paths.length === 1 && paths[0] ? `${baseNameOf(paths[0])}.zip` : "polaris-files.zip";
    return new Response(createZipStream(sources()), {
        status: 200,
        headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${asciiFallback(archiveName)}"; filename*=UTF-8''${encodeURIComponent(archiveName)}`,
            "cache-control": "no-store"
        }
    });
}
