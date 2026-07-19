/**
 * Bulk download. Streams the selected files and folders as a single ZIP so a
 * multi-item (or whole-folder) download is one click and one file - the browser
 * cannot fire many individual downloads reliably, and a folder has no single-file
 * form at all. Folders are walked server-side and every file inside is added with
 * its relative path. Each top-level item is authorized for download independently;
 * locked subtrees and the trash are skipped so gated content never leaks into the
 * archive. Store-only (no compression): the bytes stream straight from the driver.
 *
 * A POST form (not a link) carries the path list, and the attachment response lets
 * the browser stream the ZIP to disk without leaving the page. Node runtime.
 */

import { baseName, normalizeRelPath } from "@polaris/core";
import { userHasPermission } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { getDriverForConnection } from "@/lib/storage-service";
import { authorizeDrive, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import { listLocks } from "@/lib/access-lock-service";
import { createZipStream, type ZipFile } from "@/lib/zip-stream";
import { recordAudit } from "@/lib/audit-service";
import type { StorageDriver } from "@polaris/storage";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Hard ceiling on directories visited so a pathological tree cannot hang. */
const MAX_NODES = 50000;

export async function POST(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.read"))) {
        return new Response("Forbidden", { status: 403 });
    }

    const form = await request.formData();
    const connectionId = form.get("c");
    if (typeof connectionId !== "string" || !connectionId) {
        return new Response("Missing connection", { status: 400 });
    }

    // The selected items, normalized and de-duplicated.
    const rawPaths = form.getAll("p").filter((value): value is string => typeof value === "string");
    let paths: string[];
    try {
        paths = Array.from(new Set(rawPaths.map((path) => normalizeRelPath(path)).filter(Boolean)));
    } catch {
        return new Response("Invalid path", { status: 400 });
    }
    if (paths.length === 0) return new Response("Nothing selected", { status: 400 });

    // Authorize every selected item for download before opening the driver.
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
        const message = caught instanceof Error ? caught.message : "Unable to connect";
        return new Response(message, { status: 502 });
    }

    const lockedRoots = new Set((await listLocks(connectionId)).map((lock) => lock.path).filter(Boolean));

    await recordAudit({
        actorId: user.id,
        action: "drive.download.zip",
        targetType: "connection",
        targetId: connectionId,
        metadata: { count: paths.length }
    });

    /**
     * Yield every file to place in the archive. A selected file is added under its
     * own name; a selected folder is walked and each file added under
     * "<folder>/<relative path>". Top-level names are de-duplicated so two picks
     * that share a base name do not collide in the archive.
     */
    async function* files(): AsyncGenerator<ZipFile> {
        const usedTopNames = new Map<string, number>();
        let nodes = 0;

        /** Give a top-level item a unique in-archive name. */
        const uniqueTop = (name: string): string => {
            const seen = usedTopNames.get(name) ?? 0;
            usedTopNames.set(name, seen + 1);
            if (seen === 0) return name;
            const dot = name.lastIndexOf(".");
            return dot > 0 ? `${name.slice(0, dot)} (${seen})${name.slice(dot)}` : `${name} (${seen})`;
        };

        try {
            for (const path of paths) {
                const stat = await driver.stat(path);
                if (stat.kind === "file") {
                    const arcName = uniqueTop(baseName(path));
                    yield { name: arcName, size: Number(stat.size), open: () => driver.readStream(path) };
                    continue;
                }
                if (stat.kind !== "dir") continue;

                // Walk the folder; queue holds [absolutePath, archivePrefix] pairs.
                const top = uniqueTop(baseName(path));
                const queue: Array<[string, string]> = [[path, top]];
                while (queue.length > 0) {
                    if (nodes >= MAX_NODES) break;
                    const [current, prefix] = queue.shift()!;
                    nodes++;
                    let listing;
                    try {
                        listing = await driver.list(current);
                    } catch {
                        continue; // Unreadable folder: skip rather than fail the whole archive.
                    }
                    for (const entry of listing.entries) {
                        if (entry.path === ".polaris-trash" || lockedRoots.has(entry.path)) continue;
                        const arcPath = `${prefix}/${entry.name}`;
                        if (entry.kind === "dir") {
                            queue.push([entry.path, arcPath]);
                        } else if (entry.kind === "file") {
                            yield {
                                name: arcPath,
                                size: Number(entry.size),
                                open: () => driver.readStream(entry.path)
                            };
                        }
                    }
                }
            }
        } finally {
            await driver.dispose();
        }
    }

    const stamp = new Date().toISOString().slice(0, 10);
    const archiveName = paths.length === 1 ? `${baseName(paths[0]!)}.zip` : `polaris-${stamp}.zip`;
    return new Response(createZipStream(files()), {
        status: 200,
        headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(archiveName)}`,
            "cache-control": "no-store"
        }
    });
}
