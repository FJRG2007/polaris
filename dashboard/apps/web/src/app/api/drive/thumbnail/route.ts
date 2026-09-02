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

/**
 * "Keep the icon."
 *
 * Held for a day rather than sent back bare, because otherwise the files this
 * refuses are the ones asked for again on every single page load - and they are
 * the expensive ones. The answer is safe to hold for the same reason the picture
 * is: the caller puts the file's identity in the query, so an edited file is a
 * different address rather than a stale refusal.
 *
 * A day and not the year a picture gets, because a refusal can stop being true
 * without the file changing - a Polaris that has been updated may draw what this
 * build could not.
 */
const KEEP_THE_ICON = { "cache-control": "private, max-age=86400" };

/** The same answer, for a drive that did not respond. Not held at all: nothing
 *  about the file was decided, and it is right again as soon as the drive is. */
const NOT_NOW = { "cache-control": "no-store" };

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
    if (!kind) return new Response(null, { status: 404, headers: KEEP_THE_ICON });

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
            return new Response(null, { status: 404, headers: KEEP_THE_ICON });
        }
        const picture = await thumbnailFor(
            kind,
            thumbnailKey(connectionId, path, stat.modifiedAt, stat.size),
            // Read only if there is no picture already. This is the whole reason
            // it is a function: the cache is checked before the original is
            // opened, not after.
            async () => await collectStream(await driver.readStream(path))
        );
        if (!picture) return new Response(null, { status: 404, headers: KEEP_THE_ICON });
        return new Response(new Uint8Array(picture), {
            headers: {
                "content-type": "image/webp",
                "content-length": String(picture.byteLength),
                // Private, because it is a picture of somebody's file and a
                // shared cache has no business holding it.
                "cache-control": "private, max-age=31536000, immutable"
            }
        });
    } catch (caught) {
        // Nothing here is the file saying no - it is the drive, or the cache, or
        // a library that did not start. The tile is told the same thing either
        // way, because there is nothing a reader could do with the difference,
        // but it is written down: otherwise a share that has gone away and a
        // native binary missing from the image both read as "the icons stayed".
        console.warn(`drive: no thumbnail could be served for ${connectionId}:`, caught);
        return new Response(null, { status: 404, headers: NOT_NOW });
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}
