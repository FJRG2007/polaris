/**
 * The face for one account.
 *
 * One URL whatever the answer turns out to be - the photo they uploaded, their
 * Gravatar, or nothing - so no screen has to know which. Nothing is a
 * transparent pixel rather than a 404: the initials the component drew show
 * through it, and the dashboard stops looking like it is failing to load an
 * image for every account that has not set one. See lib/avatar-blank.
 *
 * Signed in only. Confirming that a given account exists, and handing over the
 * photo attached to it, is not something to serve to whoever asks; a profile
 * photo is personal data even when the person chose it.
 */

import { requireUser } from "@/lib/session";
import { resolveAvatar } from "@/lib/avatar-service";
import { BLANK_AVATAR_ETAG, blankAvatarResponse } from "@/lib/avatar-blank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Five minutes, revalidated after that.
 *
 * A face appears dozens of times on one board, so it has to be cacheable; a
 * changed photo showing up minutes later on somebody else's screen costs
 * nothing, and the revalidation that follows is a 304 rather than the bytes.
 * Private, because this is one person's picture served to one signed-in reader,
 * not something a shared proxy may keep.
 */
const CACHE = "private, max-age=300, must-revalidate";

export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
    await requireUser();
    const { userId } = await params;

    const picture = await resolveAvatar(userId);
    // Cached too: an account with no picture is the common case, and without
    // this every one of them is asked for again on every screen.
    if (!picture) {
        if (request.headers.get("if-none-match") === BLANK_AVATAR_ETAG) {
            return new Response(null, {
                status: 304,
                headers: { ETag: BLANK_AVATAR_ETAG, "Cache-Control": CACHE }
            });
        }
        return blankAvatarResponse(CACHE);
    }

    // Answered before the bytes are fetched, which is the point of the split:
    // most requests for a face are a browser checking the one it already has.
    if (request.headers.get("if-none-match") === picture.etag) {
        return new Response(null, { status: 304, headers: { ETag: picture.etag, "Cache-Control": CACHE } });
    }

    const bytes = await picture.load();
    // The row said there was a picture and the bytes are gone - a swept upload,
    // a storage target that moved. Same answer as having none: the screen wants
    // initials, not a broken image.
    if (!bytes) return blankAvatarResponse(CACHE);

    return new Response(bytes as BodyInit, {
        headers: {
            "Content-Type": picture.mime,
            "Content-Length": String(bytes.length),
            ETag: picture.etag,
            "Cache-Control": CACHE,
            // These bytes came from a person or from Gravatar and are served
            // from Polaris's own origin: the browser must treat them as the
            // image they were sniffed to be and nothing else, and must not be
            // talked into running anything found inside them.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": "inline"
        }
    });
}
