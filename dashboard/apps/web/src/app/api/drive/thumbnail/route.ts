/**
 * The picture behind one tile of the grid.
 *
 * Authorized exactly as a download is, through the same driver and the same
 * refusals, because that is what it is: a read of the file, done here so the
 * browser is handed four kilobytes instead of forty megabytes. A folder somebody
 * cannot open has no pictures either.
 *
 * A file that cannot have a picture answers 404, and 404 is not an error here -
 * it is how a tile is told to keep its icon. So it is the answer for a name this
 * cannot draw, a file past the size worth opening, an encrypted document, and an
 * image whose name lies about what it is. None of those are worth a message.
 *
 * The response is immutable for a year, and that is safe because the caller
 * names the version: the grid already knows when each entry changed and how big
 * it is, and puts both in the query. An edited file is therefore a different URL
 * rather than a stale picture, and nothing anywhere has to be invalidated.
 */

import { normalizeRelPath } from "@polaris/core";
import { requireUser, sessionCan } from "@/lib/session";
import { requireDriveDriver, DriveAccessError, DriveLockedError } from "@/lib/drive-authz";
import {
    collectStream,
    thumbnailFor,
    thumbnailKey,
    thumbnailKind,
    withinCeiling
} from "@/lib/drive-thumbnail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Kept out of the audit trail on purpose. A thumbnail is drawn by scrolling
 *  past a folder, and a log where every tile is a read event is a log in which
 *  the downloads nobody can see any more. */
export async function GET(request: Request): Promise<Response> {
    const user = await requireUser();
    if (!(await sessionCan(user, "drive.read"))) return new Response(null, { status: 403 });

    const url = new URL(request.url);
    const connectionId = url.searchParams.get("c");
    if (!connectionId) return new Response(null, { status: 400 });

    let path: string;
    try {
        path = normalizeRelPath(url.searchParams.get("p") ?? "");
    } catch {
        return new Response(null, { status: 400 });
    }

    const kind = thumbnailKind(path);
    if (!kind) return new Response(null, { status: 404 });

    let driver;
    try {
        driver = await requireDriveDriver(user.id, connectionId, path, "download");
    } catch (caught) {
        if (caught instanceof DriveLockedError) return new Response(null, { status: 423 });
        if (caught instanceof DriveAccessError) return new Response(null, { status: 403 });
        throw caught;
    }

    try {
        const stat = await driver.stat(path);
        if (stat.kind !== "file" || !withinCeiling(kind, stat.size)) {
            return new Response(null, { status: 404 });
        }
        const picture = await thumbnailFor(
            kind,
            thumbnailKey(connectionId, path, stat.modifiedAt, stat.size),
            // Read only if there is no picture already. This is the whole reason
            // it is a function: the cache is checked before the original is
            // opened, not after.
            async () => await collectStream(await driver.readStream(path))
        );
        if (!picture) return new Response(null, { status: 404 });
        return new Response(new Uint8Array(picture), {
            headers: {
                "content-type": "image/webp",
                "content-length": String(picture.byteLength),
                // Private, because it is a picture of somebody's file and a
                // shared cache has no business holding it.
                "cache-control": "private, max-age=31536000, immutable"
            }
        });
    } catch {
        return new Response(null, { status: 404 });
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}
