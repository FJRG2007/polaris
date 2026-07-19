/**
 * "Recent files" for one connection, like a file manager's recent list. Three
 * modes, chosen with `by`:
 *   - modified / created: a bounded recursive walk of the connection collecting
 *     files, sorted by their modified or created time, newest first.
 *   - opened: the caller's own recent open/download and upload events from the
 *     audit log, de-duplicated by path and confirmed to still exist.
 * Auth is re-checked, the base is authorized for read, and Polaris-internal and
 * locked subtrees are skipped so nothing gated leaks here. Node runtime for the
 * drivers and Prisma.
 */

import { normalizeRelPath } from "@polaris/core";
import { userHasPermission } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { getDriverForConnection, SmbShareRequiredError } from "@/lib/storage-service";
import { authorizeDrive, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import { listLocks } from "@/lib/access-lock-service";
import { getMetaMap } from "@/lib/drive-meta-service";
import { isReservedRootPath } from "@/lib/system-paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Files returned to the client. */
const RESULT_LIMIT = 100;
/** Directories visited during a modified/created walk before it stops. */
const MAX_NODES = 20000;
/** Files buffered before sorting, so a huge tree cannot exhaust memory. */
const WALK_CAP = 4000;
/** Audit rows scanned for the "opened" mode. */
const OPENED_SCAN = 400;

type RecentSort = "modified" | "created" | "opened";

interface RecentEntry {
    name: string;
    path: string;
    kind: "file";
    size: string;
    modifiedAt: string;
    createdAt: string;
    /** When the item was last opened (opened mode only). */
    openedAt?: string;
    favorite?: boolean;
    hidden?: boolean;
}

/** Base name of a relative path ("a/b/c.txt" -> "c.txt"). */
function baseNameOf(path: string): string {
    const slash = path.lastIndexOf("/");
    return slash >= 0 ? path.slice(slash + 1) : path;
}

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("c");
    if (!connectionId) return Response.json({ error: "Missing connection" }, { status: 400 });
    const byParam = url.searchParams.get("by");
    const by: RecentSort = byParam === "created" ? "created" : byParam === "opened" ? "opened" : "modified";

    try {
        await authorizeDrive(user.id, connectionId, "", "read");
    } catch (caught) {
        if (caught instanceof DriveLockedError) {
            return Response.json({ locked: true, lockId: caught.lockId, lockPath: caught.lockPath });
        }
        if (caught instanceof DriveAccessError) return Response.json({ error: "Forbidden" }, { status: 403 });
        throw caught;
    }

    let driver;
    try {
        driver = await getDriverForConnection(connectionId);
    } catch (caught) {
        if (caught instanceof SmbShareRequiredError) return Response.json({ needsSmbShare: true });
        const message = caught instanceof Error ? caught.message : "Unable to connect";
        return Response.json({ error: message }, { status: 502 });
    }

    const lockedRoots = new Set((await listLocks(connectionId)).map((lock) => lock.path).filter(Boolean));
    const underLockedRoot = (path: string): boolean => {
        for (const root of lockedRoots) {
            if (path === root || path.startsWith(`${root}/`)) return true;
        }
        return false;
    };

    try {
        let entries: RecentEntry[];
        if (by === "opened") {
            entries = await recentlyOpened(driver, user.id, connectionId, underLockedRoot);
        } else {
            entries = await recentlyTouched(driver, by, lockedRoots);
        }

        const meta = await getMetaMap(
            connectionId,
            entries.map((entry) => entry.path)
        );
        for (const entry of entries) {
            const item = meta.get(entry.path);
            entry.favorite = item?.favorite ?? false;
            entry.hidden = item?.hidden ?? false;
        }
        return Response.json({ entries });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Could not load recent files";
        return Response.json({ error: message }, { status: 502 });
    } finally {
        await driver.dispose();
    }
}

/** Walk the tree collecting files, then sort by modified or created time. */
async function recentlyTouched(
    driver: Awaited<ReturnType<typeof getDriverForConnection>>,
    by: "modified" | "created",
    lockedRoots: Set<string>
): Promise<RecentEntry[]> {
    const files: RecentEntry[] = [];
    let nodes = 0;
    const queue: string[] = [""];
    while (queue.length > 0 && nodes < MAX_NODES && files.length < WALK_CAP) {
        const current = queue.shift() as string;
        nodes++;
        let listing;
        try {
            listing = await driver.list(current);
        } catch {
            continue;
        }
        for (const entry of listing.entries) {
            if (isReservedRootPath(entry.path)) continue;
            if (entry.kind === "dir") {
                if (!lockedRoots.has(entry.path)) queue.push(entry.path);
                continue;
            }
            const modifiedAt = entry.modifiedAt.toISOString();
            const createdAt = (entry.createdAt ?? entry.modifiedAt).toISOString();
            files.push({
                name: entry.name,
                path: entry.path,
                kind: "file",
                size: entry.size.toString(),
                modifiedAt,
                createdAt
            });
        }
    }
    const key = by === "created" ? "createdAt" : "modifiedAt";
    files.sort((a, b) => (a[key] < b[key] ? 1 : a[key] > b[key] ? -1 : 0));
    return files.slice(0, RESULT_LIMIT);
}

/** The caller's recent open/download/upload events, de-duplicated and confirmed to exist. */
async function recentlyOpened(
    driver: Awaited<ReturnType<typeof getDriverForConnection>>,
    userId: string,
    connectionId: string,
    underLockedRoot: (path: string) => boolean
): Promise<RecentEntry[]> {
    const rows = await prisma.auditLog.findMany({
        where: { actorId: userId, targetId: connectionId, action: { in: ["drive.download", "drive.upload"] } },
        orderBy: { at: "desc" },
        take: OPENED_SCAN,
        select: { metadata: true, at: true }
    });

    // Newest event per path (rows are already newest-first).
    const seen = new Map<string, Date>();
    for (const row of rows) {
        if (!row.metadata) continue;
        let path: string | undefined;
        try {
            path = (JSON.parse(row.metadata) as { path?: string }).path;
        } catch {
            path = undefined;
        }
        if (!path) continue;
        const normalized = normalizeRelPath(path);
        if (!normalized || isReservedRootPath(normalized) || underLockedRoot(normalized)) continue;
        if (!seen.has(normalized)) seen.set(normalized, row.at);
    }

    const results: RecentEntry[] = [];
    for (const [path, openedAt] of seen) {
        if (results.length >= RESULT_LIMIT) break;
        try {
            const stat = await driver.stat(path);
            if (stat.kind !== "file") continue;
            results.push({
                name: baseNameOf(path),
                path,
                kind: "file",
                size: stat.size.toString(),
                modifiedAt: stat.modifiedAt.toISOString(),
                createdAt: (stat.createdAt ?? stat.modifiedAt).toISOString(),
                openedAt: openedAt.toISOString()
            });
        } catch {
            // The file was moved or deleted since; drop it from the recent list.
        }
    }
    return results;
}
