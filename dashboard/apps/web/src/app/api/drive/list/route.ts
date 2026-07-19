/**
 * Directory listing as JSON, for the client-side Drive browser. Moving the list
 * off the server-rendered page means the Drive shell paints instantly and the
 * (sometimes slow, network-bound) listing streams in behind a skeleton instead
 * of blocking the whole navigation. Auth is re-checked here; the client is never
 * trusted. Access is authorized per path (ownership or ACL) and the access gate
 * is enforced: a locked folder returns a `locked` marker so the UI can prompt for
 * the password instead of leaking a listing. Node runtime because Prisma and the
 * drivers need it.
 */

import { normalizeRelPath } from "@polaris/core";
import { userHasPermission } from "@polaris/auth";
import { requireUser } from "@/lib/session";
import { getDriverForConnection, SmbShareRequiredError } from "@/lib/storage-service";
import { authorizeDrive, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import { getMetaMap } from "@/lib/drive-meta-service";
import { listLocks } from "@/lib/access-lock-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
        // A locked ancestor: tell the client which lock to unlock rather than 403.
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
        // A UNAS with no SMB share yet: tell the client to ask for the share name
        // rather than surfacing a generic failure (credentials are reused).
        if (caught instanceof SmbShareRequiredError) {
            return Response.json({ needsSmbShare: true });
        }
        const message = caught instanceof Error ? caught.message : "Unable to connect";
        return Response.json({ error: message }, { status: 502 });
    }

    try {
        const listing = await driver.list(path);
        // Hide the Polaris trash folder from normal browsing; it lives at the root
        // of each connection and is managed through the Trash page instead.
        const visibleEntries = listing.entries.filter((entry) => entry.path !== ".polaris-trash");
        const [meta, locks] = await Promise.all([
            getMetaMap(
                connectionId,
                visibleEntries.map((entry) => entry.path)
            ),
            listLocks(connectionId)
        ]);
        const lockedPaths = new Set(locks.map((lock) => lock.path));
        const entries = visibleEntries.map((entry) => {
            const item = meta.get(entry.path);
            return {
                name: entry.name,
                path: entry.path,
                kind: entry.kind,
                size: entry.size.toString(),
                modifiedAt: entry.modifiedAt.toISOString(),
                createdAt: (entry.createdAt ?? entry.modifiedAt).toISOString(),
                hidden: item?.hidden ?? false,
                favorite: item?.favorite ?? false,
                icon: item?.icon ?? null,
                iconColor: item?.iconColor ?? null,
                note: item?.note ?? null,
                // A folder that is itself an access-gate root, for a lock badge.
                locked: lockedPaths.has(entry.path)
            };
        });
        return Response.json({ entries });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "Unable to list this location";
        return Response.json({ error: message }, { status: 502 });
    } finally {
        await driver.dispose();
    }
}
