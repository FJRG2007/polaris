/**
 * The picture behind one tile of a shared folder.
 *
 * The share's counterpart of `api/drive/thumbnail`: the same drawing and the
 * same cache, behind the share's own gate instead of a session. The token (plus
 * the unlock cookie of a password-protected link) is the credential, and the
 * path has to stay inside the shared subtree, exactly as for a download.
 *
 * A thumbnail is a preview of the file, so it is refused where previews are: a
 * link with previews switched off shows icons. It is never counted against the
 * link's download cap and never written to its visit log - a visitor scrolling
 * past a folder of four hundred photos has not downloaded or viewed four hundred
 * files, and a log full of tiles would hide the downloads that did happen. A
 * refused request is still logged by the gate, as every refusal is.
 *
 * 404 is how a tile is told to keep its icon, as on the owner's side.
 */

import { gateShareRequest } from "@/lib/share-access";
import { resolveWithinShare } from "@/lib/share-service";
import { getDriverForConnection } from "@/lib/storage-service";
import {
    collectStream,
    thumbnailFor,
    thumbnailKey,
    thumbnailKind,
    withinCeiling
} from "@/lib/drive-thumbnail";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** "Keep the icon", held for a day - see `api/drive/thumbnail`. */
const KEEP_THE_ICON = { "cache-control": "private, max-age=86400" };

/** The same answer for a drive that did not respond, not held at all. */
const NOT_NOW = { "cache-control": "no-store" };

export async function GET(
    request: Request,
    { params }: { params: Promise<{ token: string }> }
): Promise<Response> {
    const { token } = await params;
    const gate = await gateShareRequest(token, "thumbnail");
    if (!gate.ok) return new Response(null, { status: gate.status });
    const { share } = gate;
    if (!share.allowPreview) return new Response(null, { status: 403 });

    let target: string | null;
    try {
        target = resolveWithinShare(share.path, new URL(request.url).searchParams.get("p"));
    } catch {
        target = null;
    }
    if (target === null) return new Response(null, { status: 400 });

    const kind = thumbnailKind(target);
    if (!kind) return new Response(null, { status: 404, headers: KEEP_THE_ICON });

    const driver = await getDriverForConnection(share.connectionId);
    try {
        const stat = await driver.stat(target);
        if (stat.kind !== "file" || !withinCeiling(kind, stat.size)) {
            return new Response(null, { status: 404, headers: KEEP_THE_ICON });
        }
        const path = target;
        const picture = await thumbnailFor(
            kind,
            thumbnailKey(share.connectionId, path, stat.modifiedAt, stat.size),
            async () => await collectStream(await driver.readStream(path))
        );
        if (!picture) return new Response(null, { status: 404, headers: KEEP_THE_ICON });
        return new Response(new Uint8Array(picture), {
            headers: {
                "content-type": "image/webp",
                "content-length": String(picture.byteLength),
                // Private: a picture of somebody's file has no place in a shared
                // cache. The version is in the address, so it can be held.
                "cache-control": "private, max-age=31536000, immutable"
            }
        });
    } catch (caught) {
        console.warn(`share: no thumbnail could be served for share ${share.id}:`, caught);
        return new Response(null, { status: 404, headers: NOT_NOW });
    } finally {
        await driver.dispose().catch(() => undefined);
    }
}
