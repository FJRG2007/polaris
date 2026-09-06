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

import { normalizeRelPath, storageFailure, storageFailureDetail } from "@polaris/core";
import { apiUser } from "@/lib/api-session";
import { sessionCan } from "@/lib/session";
import { getDriverForConnection, SmbShareRequiredError } from "@/lib/storage-service";
import {
    authorizeDrive,
    canManageDriveConnection,
    DriveAccessError,
    DriveLockedError
} from "@/lib/drive-authz";
import { getMetaMap, resolveUserNames } from "@/lib/drive-meta-service";
import { listLocks } from "@/lib/access-lock-service";
import { isReservedRootPath } from "@/lib/system-paths";
import { sweepDueDeletions } from "@/lib/scheduled-deletion-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!(await sessionCan(user, "drive.read"))) {
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

    // Lazily run any deletions that came due on this connection (Polaris has no
    // standing scheduler); never let a sweep failure block the listing.
    try {
        await sweepDueDeletions(connectionId);
    } catch {
        // Best effort; a failed sweep is retried on the next browse or the cron.
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
        return await failed(user, connectionId, caught, "connect");
    }

    try {
        const listing = await driver.list(path);
        // Hide Polaris's own hidden folder (trash, quarantine) from normal browsing;
        // it lives at the root of each connection and is managed elsewhere.
        const visibleEntries = listing.entries.filter((entry) => !isReservedRootPath(entry.path));
        const [meta, locks] = await Promise.all([
            getMetaMap(
                connectionId,
                visibleEntries.map((entry) => entry.path)
            ),
            listLocks(connectionId)
        ]);
        const lockedPaths = new Set(locks.map((lock) => lock.path));
        // Resolve the creator ids present in this listing to display names once.
        const names = await resolveUserNames(
            [...meta.values()].map((item) => item.creatorId).filter((id): id is string => Boolean(id))
        );
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
                owner: item?.creatorId ? (names.get(item.creatorId) ?? null) : null,
                // A folder that is itself an access-gate root, for a lock badge.
                locked: lockedPaths.has(entry.path)
            };
        });
        // Never held. A listing is the answer to "what is in here NOW", and a
        // browser that reuses a two-minute-old one shows a folder somebody has
        // just uploaded into as it was before they did - which is what "the
        // count does not change until I reload the page" was.
        return Response.json({ entries }, { headers: { "cache-control": "no-store" } });
    } catch (caught) {
        return await failed(user, connectionId, caught, "list");
    } finally {
        await driver.dispose();
    }
}

/**
 * What the client is told when a location would not answer.
 *
 * The reason is classified rather than repeated: a driver's own words name
 * hosts, shares and paths, and somebody who was given a folder was not given
 * the device behind it. The exact text goes to the log, and to the reader only
 * when they administer this connection - on a deployment where nobody opens a
 * terminal, an administrator with the reason removed has nowhere left to look.
 */
async function failed(
    user: { id: string; isAdmin: boolean },
    connectionId: string,
    caught: unknown,
    at: "connect" | "list"
): Promise<Response> {
    console.error(`drive: ${at} failed`, caught);
    const failure = storageFailure(caught);
    const detail = (await canManageDriveConnection(user.id, user.isAdmin, connectionId))
        ? storageFailureDetail(caught)
        : null;
    return Response.json(
        { error: failure.reason, hint: failure.hint, retryable: failure.retryable, detail },
        { status: 502 }
    );
}
