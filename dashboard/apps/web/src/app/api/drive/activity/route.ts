/**
 * Per-item activity feed for the Drive side panel. Returns the recent audit
 * events that touched one path on a connection - downloads, renames, moves,
 * copies, creation, trashing - with the actor's name. Auth is re-checked and the
 * path is authorized for read, so activity never leaks for a location the caller
 * cannot see. The global audit log is the source; rows are matched by the path in
 * their metadata (which is a JSON string, so filtering happens in app over a
 * bounded recent window). Node runtime for Prisma.
 */

import { normalizeRelPath } from "@polaris/core";
import { userHasPermission } from "@polaris/auth";
import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { authorizeDrive, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import { resolveUserNames } from "@/lib/drive-meta-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Recent drive events scanned per request; matches for one path are sparse. */
const SCAN_WINDOW = 400;
/** Events returned for the panel. */
const MAX_RESULTS = 25;

/** Whether an audit row's metadata references the given path. */
function touchesPath(metadataJson: string | null, path: string): boolean {
    if (!metadataJson) return false;
    try {
        const meta = JSON.parse(metadataJson) as { path?: string; from?: string; to?: string };
        return meta.path === path || meta.from === path || meta.to === path;
    } catch {
        return false;
    }
}

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await userHasPermission(user.id, "drive.read"))) {
        return Response.json({ error: "Forbidden" }, { status: 403 });
    }

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("c");
    if (!connectionId) return Response.json({ error: "Missing connection" }, { status: 400 });

    let path: string;
    try {
        path = normalizeRelPath(url.searchParams.get("p") ?? "");
    } catch {
        return Response.json({ error: "Invalid path" }, { status: 400 });
    }

    try {
        await authorizeDrive(user.id, connectionId, path, "read");
    } catch (caught) {
        if (caught instanceof DriveLockedError || caught instanceof DriveAccessError) {
            return Response.json({ error: "Forbidden" }, { status: 403 });
        }
        throw caught;
    }

    const rows = await prisma.auditLog.findMany({
        where: { targetId: connectionId, action: { startsWith: "drive." } },
        orderBy: { at: "desc" },
        take: SCAN_WINDOW,
        select: { id: true, action: true, actorId: true, metadata: true, at: true }
    });

    const matched = rows.filter((row) => touchesPath(row.metadata, path)).slice(0, MAX_RESULTS);
    const names = await resolveUserNames(
        matched.map((row) => row.actorId).filter((id): id is string => Boolean(id))
    );

    const items = matched.map((row) => ({
        id: row.id,
        action: row.action,
        actor: row.actorId ? (names.get(row.actorId) ?? null) : null,
        at: row.at.toISOString()
    }));
    return Response.json({ items });
}
