/**
 * The banner across the top of one profile.
 *
 * The same arrangement as the face beside it, for the same reasons: one URL
 * whatever the answer turns out to be, a transparent pixel rather than a 404 for
 * the accounts that have no banner - which is most of them - so a profile does
 * not fire a failed request every time it opens, and the colour drawn underneath
 * shows through either way.
 *
 * It answers to the same privacy setting the photo does. A banner is a picture
 * somebody put on their profile; splitting it into a setting of its own would be
 * a seventh row on that screen answering a question nobody asked separately.
 *
 * Signed in only, like every other picture here.
 */

import { requireUser } from "@/lib/session";
import { maySee } from "@/lib/privacy-service";
import { resolveBanner } from "@/lib/avatar-service";
import { BLANK_AVATAR_ETAG, blankAvatarResponse } from "@/lib/avatar-blank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Kept and checked every time - see the avatar route, which explains why. */
const CACHE = "private, no-cache";

/** What a failure is cached as, which is not at all. */
const NO_CACHE = "private, no-store";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ userId: string }> }
): Promise<Response> {
    const viewer = await requireUser();
    const { userId } = await params;

    const visible = await maySee(userId, "avatar", { id: viewer.id, isAdmin: Boolean(viewer.isAdmin) });
    if (!visible) return blankAvatarResponse(CACHE);

    const picture = await resolveBanner(userId);
    if (!picture) {
        if (request.headers.get("if-none-match") === BLANK_AVATAR_ETAG) {
            return new Response(null, {
                status: 304,
                headers: { ETag: BLANK_AVATAR_ETAG, "Cache-Control": CACHE }
            });
        }
        return blankAvatarResponse(CACHE);
    }

    // Answered before the bytes are fetched: most requests for a picture are a
    // browser checking the one it already has.
    if (request.headers.get("if-none-match") === picture.etag) {
        return new Response(null, { status: 304, headers: { ETag: picture.etag, "Cache-Control": CACHE } });
    }

    const bytes = await picture.load();
    // The row said there was a picture and the bytes did not arrive - a storage
    // that is not answering this second. The colour underneath stands in, and
    // nothing is cached: this is a failure to fetch, not a fact about the account.
    if (!bytes) return blankAvatarResponse(NO_CACHE);

    return new Response(bytes as BodyInit, {
        headers: {
            "Content-Type": picture.mime,
            "Content-Length": String(bytes.length),
            ETag: picture.etag,
            "Cache-Control": CACHE,
            // These bytes came from a person and are served from Polaris's own
            // origin: the browser must treat them as the image they were sniffed
            // to be and must not be talked into running anything found inside.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": "inline"
        }
    });
}
