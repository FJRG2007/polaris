/**
 * Public share search. Walks the shared subtree server-side so a query can match
 * items nested arbitrarily deep, returning them with their full relative paths.
 * The token is the credential, gated exactly like the download route; the base
 * stays inside the shared subtree, reserved folders are skipped, and the walk is
 * bounded on both results and nodes so a huge tree cannot hang the request. Node
 * runtime for Prisma and the drivers.
 */

import { getDriverForConnection } from "@/lib/storage-service";
import { resolveWithinShare } from "@/lib/share-service";
import { gateShareRequest } from "@/lib/share-access";
import { isReservedRootPath } from "@/lib/system-paths";
import {
    matchesStructured,
    normalizePathTarget,
    parseSearch
} from "@/app/(app)/drive/search-query";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Stop after this many matches so a broad query stays responsive. */
const MAX_RESULTS = 500;
/** Hard ceiling on directories visited, so a deep tree cannot hang the request. */
const MAX_NODES = 20000;

export async function GET(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const gate = await gateShareRequest(token, "list");
    if (!gate.ok) return Response.json({ error: gate.reason }, { status: gate.status });

    const url = new URL(request.url);
    const base = resolveWithinShare(gate.share.path, url.searchParams.get("p"));
    if (base === null) return Response.json({ error: "path_outside_share" }, { status: 400 });

    const parsed = parseSearch(url.searchParams.get("q") ?? "");
    if (parsed.error) return Response.json({ error: parsed.error }, { status: 400 });
    const fuzzyWords = parsed.fuzzy ? parsed.fuzzy.toLowerCase().split(/\s+/).filter(Boolean) : [];
    const hasCriteria =
        parsed.extensions.length > 0 || parsed.patterns.length > 0 || fuzzyWords.length > 0;
    if (!hasCriteria) return Response.json({ entries: [], truncated: false });

    /** Whether an entry satisfies the whole query (structured plus fuzzy words). */
    const matches = (name: string, path: string): boolean => {
        if (!matchesStructured(name, path, parsed)) return false;
        if (fuzzyWords.length === 0) return true;
        const haystack = parsed.pathMode ? normalizePathTarget(path) : name.toLowerCase();
        return fuzzyWords.every((word) => haystack.includes(word));
    };

    const driver = await getDriverForConnection(gate.share.connectionId);
    const results: Array<Record<string, string>> = [];
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
                continue; // Unreadable folder: skip rather than failing the search.
            }
            for (const entry of listing.entries) {
                if (isReservedRootPath(entry.path)) continue;
                if (entry.kind === "dir") queue.push(entry.path);
                if (matches(entry.name, entry.path)) {
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
                        createdAt: (entry.createdAt ?? entry.modifiedAt).toISOString()
                    });
                }
            }
        }
        return Response.json({ entries: results, truncated });
    } catch (caught) {
        console.error("share: search failed", caught);
        return Response.json({ error: "search_failed" }, { status: 502 });
    } finally {
        await driver.dispose();
    }
}
