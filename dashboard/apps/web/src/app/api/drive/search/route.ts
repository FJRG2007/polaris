/**
 * Recursive search under a path. The client's normal search filters the already
 * loaded listing (one folder); this route walks the subtree server-side so a
 * query can match items nested arbitrarily deep, returning them with their full
 * relative paths. It is bounded on both results and nodes visited so a huge tree
 * cannot hang the request, and it never descends into the trash or into a locked
 * subtree - gated content must not leak through search. Node runtime for Prisma
 * and the drivers.
 */

import { normalizeRelPath } from "@polaris/core";
import { userHasPermission } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { getDriverForConnection, SmbShareRequiredError } from "@/lib/storage-service";
import { authorizeDrive, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import { listLocks } from "@/lib/access-lock-service";
import { parseSearch, matchesStructured } from "@/app/(app)/drive/search-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stop after this many matches so a broad query stays responsive. */
const MAX_RESULTS = 500;
/** Hard ceiling on directories visited, so a deep tree cannot hang the request. */
const MAX_NODES = 20000;

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("c");
    const rawQuery = url.searchParams.get("q") ?? "";
    if (!connectionId) return Response.json({ error: "Missing connection" }, { status: 400 });

    let base: string;
    try {
        base = normalizeRelPath(url.searchParams.get("p") ?? "");
    } catch {
        return Response.json({ error: "Invalid path" }, { status: 400 });
    }

    const parsed = parseSearch(rawQuery);
    if (parsed.error) return Response.json({ error: parsed.error }, { status: 400 });
    const fuzzyWords = parsed.fuzzy ? parsed.fuzzy.toLowerCase().split(/\s+/).filter(Boolean) : [];
    const hasCriteria = parsed.extensions.length > 0 || parsed.patterns.length > 0 || fuzzyWords.length > 0;
    if (!hasCriteria) return Response.json({ entries: [], truncated: false });

    try {
        await authorizeDrive(user.id, connectionId, base, "read");
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

    // Never descend into locked subtrees or the trash; a search must not surface
    // gated content. Skip any folder that is a lock root (and, since we do not
    // recurse into it, everything beneath it).
    const lockedRoots = new Set((await listLocks(connectionId)).map((lock) => lock.path).filter(Boolean));

    /** Whether a filename satisfies the whole query (structured plus fuzzy words). */
    const matches = (name: string): boolean => {
        if (!matchesStructured(name, parsed)) return false;
        if (fuzzyWords.length === 0) return true;
        const lower = name.toLowerCase();
        return fuzzyWords.every((word) => lower.includes(word));
    };

    const results: Array<Record<string, string | boolean>> = [];
    let nodes = 0;
    let truncated = false;

    try {
        const queue: string[] = [base];
        while (queue.length > 0) {
            if (results.length >= MAX_RESULTS || nodes >= MAX_NODES) {
                truncated = queue.length > 0;
                break;
            }
            const current = queue.shift() as string;
            nodes++;
            let listing;
            try {
                listing = await driver.list(current);
            } catch {
                continue; // Unreadable folder: skip it rather than failing the whole search.
            }
            for (const entry of listing.entries) {
                if (entry.path === ".polaris-trash") continue;
                if (entry.kind === "dir" && !lockedRoots.has(entry.path)) queue.push(entry.path);
                if (matches(entry.name)) {
                    if (results.length >= MAX_RESULTS) {
                        truncated = true;
                        break;
                    }
                    results.push({
                        name: entry.name,
                        path: entry.path,
                        kind: entry.kind,
                        size: entry.size.toString(),
                        modifiedAt: entry.modifiedAt.toISOString(),
                        createdAt: (entry.createdAt ?? entry.modifiedAt).toISOString(),
                        locked: lockedRoots.has(entry.path)
                    });
                }
            }
        }
        return Response.json({ entries: results, truncated });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Search failed";
        return Response.json({ error: message }, { status: 502 });
    } finally {
        await driver.dispose();
    }
}
