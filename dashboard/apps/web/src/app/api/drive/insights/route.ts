/**
 * The parts of a listing that cannot be read from a directory entry: what each
 * sub-folder weighs, and which archives are password-protected. Both need work
 * the listing itself must not wait for, so they load separately and fill in
 * behind the file table.
 *
 * One request opens one connection to the backend and spends a bounded amount of
 * time on it. Whatever it finishes is returned and cached; folders it did not
 * get to come back as `pending`, and the client asks again - each round starts
 * from the cache the last one left behind, so a large tree converges instead of
 * timing out. Auth, the access gate and the reserved-folder rules are re-applied
 * here exactly as in the listing: a gated folder is never opened or measured.
 * Node runtime because Prisma and the drivers need it.
 */

import { normalizeRelPath } from "@polaris/core";
import { requireUser, sessionCan } from "@/lib/session";
import { getDriverForConnection, SmbShareRequiredError } from "@/lib/storage-service";
import { authorizeDrive, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import { isProbableArchive, probeArchiveEncryption } from "@/lib/drive-archive-encryption";
import { createSizeBudget, getCachedFolderSizes, measureFolder } from "@/lib/drive-folder-size";
import { listLocks } from "@/lib/access-lock-service";
import { isReservedRootPath } from "@/lib/system-paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Wall-clock this request may spend walking folders before it defers the rest. */
const SIZE_BUDGET_MS = 8000;
/** Wall-clock this request may spend reading archive headers. */
const ARCHIVE_BUDGET_MS = 4000;
/** Archives inspected per request, so a folder full of them stays responsive. */
const MAX_ARCHIVES = 60;

export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
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
        if (caught instanceof DriveLockedError) return Response.json({ locked: true });
        if (caught instanceof DriveAccessError)
            return Response.json({ error: "Forbidden" }, { status: 403 });
        throw caught;
    }

    let driver;
    try {
        driver = await getDriverForConnection(connectionId);
    } catch (caught) {
        if (caught instanceof SmbShareRequiredError) return Response.json({ needsSmbShare: true });
        console.error("drive: insights connect failed", caught);
        return Response.json({ error: "Could not connect to this location" }, { status: 502 });
    }

    try {
        const listing = await driver.list(path);
        const entries = listing.entries.filter((entry) => !isReservedRootPath(entry.path));
        const gated = new Set(
            (await listLocks(connectionId)).map((lock) => lock.path).filter(Boolean)
        );

        const folders = entries.filter((entry) => entry.kind === "dir" && !gated.has(entry.path));
        const sizes: Record<
            string,
            { bytes: string; files: number; folders: number; partial: boolean }
        > = {};
        const pending: string[] = [];

        // Anything measured recently is answered from the cache; only the rest is
        // walked, and only for as long as the budget allows.
        const cached = await getCachedFolderSizes(
            connectionId,
            folders.map((entry) => entry.path)
        );
        const budget = createSizeBudget(SIZE_BUDGET_MS);
        for (const folder of folders) {
            const known = cached.get(folder.path);
            const outcome =
                known !== undefined
                    ? ({ status: "measured", size: known } as const)
                    : await measureFolder(driver, connectionId, folder.path, {
                          budget,
                          skip: gated
                      });
            // An unreadable folder is reported as neither sized nor pending: it
            // stays blank in the browser instead of being asked about forever.
            if (outcome.status === "deferred") pending.push(folder.path);
            if (outcome.status !== "measured") continue;
            sizes[folder.path] = {
                bytes: outcome.size.bytes.toString(),
                files: outcome.size.files,
                folders: outcome.size.folders,
                partial: outcome.size.partial
            };
        }

        // Archive locks: a cheap header read each, capped both in count and time.
        const archives: Record<string, boolean> = {};
        const deadline = Date.now() + ARCHIVE_BUDGET_MS;
        let probed = 0;
        for (const entry of entries) {
            if (entry.kind === "dir" || !isProbableArchive(entry.name)) continue;
            if (probed++ >= MAX_ARCHIVES || Date.now() >= deadline) break;
            const encrypted = await probeArchiveEncryption(
                driver,
                connectionId,
                entry.path,
                entry.size,
                entry.modifiedAt
            );
            if (encrypted) archives[entry.path] = true;
        }

        return Response.json({ sizes, archives, pending });
    } catch (caught) {
        console.error("drive: insights failed", caught);
        return Response.json({ error: "Could not inspect this location" }, { status: 502 });
    } finally {
        await driver.dispose();
    }
}
