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
import { maySee } from "@/lib/privacy-service";
import { resolveAvatar } from "@/lib/avatar-service";
import { BLANK_AVATAR_ETAG, blankAvatarResponse } from "@/lib/avatar-blank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kept, and checked every time.
 *
 * `no-cache` does not mean "do not store" - it means "store it and ask before
 * using it", which is exactly right here. The tag is a row read, so the check
 * costs a 304 and no bytes, and a browser never has a face this instance would
 * now answer differently. The five minutes this used to hold was five minutes
 * of somebody looking at a picture that had already changed, or - worse, and
 * what actually happened - at the blank one served during a moment when the
 * storage was not answering, with no way to make it ask again short of clearing
 * the browser.
 *
 * Private, because this is one person's picture served to one signed-in reader,
 * not something a shared proxy may keep.
 */
const CACHE = "private, no-cache";

/**
 * What a failed answer is cached as, which is not at all.
 *
 * The face that came and went: one slow Gravatar lookup, or a storage that did
 * not answer, produced the same blank pixel as "this account has no photo" -
 * with the same five minutes on it. So a hiccup lasting a second took a face off
 * the screen for five minutes, in every tab that asked during it, and put it
 * back afterwards as if nothing had happened. "I could not find out" is not an
 * answer to cache.
 */
const NO_CACHE = "private, no-store";

export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
    const viewer = await requireUser();
    const { userId } = await params;

    // Somebody who keeps their photo to themselves, or to their friends. The
    // answer is the same one an account with no photo gives - the blank pixel,
    // with the component's initials showing through - rather than a refusal:
    // a 403 here would tell the person asking that there is one to see.
    const visible = await maySee(userId, "avatar", {
        id: viewer.id,
        isAdmin: Boolean(viewer.isAdmin)
    });
    if (!visible) return blankAvatarResponse(CACHE);

    const { picture, certain } = await resolveAvatar(userId);
    // Cached too: an account with no picture is the common case, and without
    // this every one of them is asked for again on every screen. Unless nobody
    // could find out, in which case the next request asks again.
    if (!picture) {
        if (certain && request.headers.get("if-none-match") === BLANK_AVATAR_ETAG) {
            return new Response(null, {
                status: 304,
                headers: { ETag: BLANK_AVATAR_ETAG, "Cache-Control": CACHE }
            });
        }
        return blankAvatarResponse(certain ? CACHE : NO_CACHE);
    }

    // Answered before the bytes are fetched, which is the point of the split:
    // most requests for a face are a browser checking the one it already has.
    if (request.headers.get("if-none-match") === picture.etag) {
        return new Response(null, { status: 304, headers: { ETag: picture.etag, "Cache-Control": CACHE } });
    }

    const bytes = await picture.load();
    // The row said there was a picture and the bytes did not arrive - a swept
    // upload, a storage target that moved, a NAS that is not answering this
    // second. Same answer as having none, since the screen wants initials rather
    // than a broken image, but not cached: the row still says there is a photo,
    // so this is a failure to fetch it and not a fact about the account.
    if (!bytes) return blankAvatarResponse(NO_CACHE);

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
