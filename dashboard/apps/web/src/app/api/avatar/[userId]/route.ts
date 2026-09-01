/**
 * The face for one account.
 *
 * One URL whatever the answer turns out to be - the photo they uploaded, their
 * Gravatar, or nothing - so no screen has to know which. Nothing is a
 * transparent pixel rather than a 404: the initials the component drew show
 * through it, and the dashboard stops looking like it is failing to load an
 * image for every account that has not set one. See lib/avatar-blank.
 *
 * Signed in only, with one exception. Confirming that a given account exists,
 * and handing over the photo attached to it, is not something to serve to whoever
 * asks; a profile photo is personal data even when the person chose it.
 *
 * The exception is a guest sitting in a call. They have no account and never
 * will, and every face in the room came back as initials for them while everybody
 * else in the same call saw photographs - one room, drawn two different ways,
 * which is exactly what a guest link is meant not to be. So a guest holding an
 * admitted seat may fetch the face of somebody admitted to the same call, and
 * nobody else's. They are still nobody as far as the privacy rule goes, so only a
 * picture whose audience is everybody reaches them.
 */

import { maySee } from "@/lib/privacy-service";
import { resolveSession } from "@/lib/session";
import { profilesArePublic } from "@/lib/profile-service";
import { resolveAvatar } from "@/lib/avatar-service";
import { inCallTogether } from "@/lib/chat/meetings";
import { resolveGuestSeat } from "@/lib/chat/meeting-seat";
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

/**
 * Who this request may be answered as, or null when it may not be answered.
 *
 * An account speaks for itself. A guest speaks for nothing, and is let through
 * only for the faces of the people in the call they are actually sitting in -
 * checked against the seat their cookie names rather than anything the request
 * asked for, so a guest link cannot be turned into a way to read faces off the
 * rest of the instance.
 */
async function whoIsAsking(subjectId: string): Promise<{ id: string; isAdmin: boolean } | null> {
    const session = await resolveSession();
    if (session) return { id: session.id, isAdmin: Boolean(session.isAdmin) };

    // A guest is answered by the guest rules and by nothing else. Falling from a
    // refused seat through to the rule below would turn "your seat is not
    // admitted" into "the instance publishes profiles, so here it is anyway",
    // which is not the same sentence and is a wider door than a call link was
    // ever meant to open.
    const seat = await resolveGuestSeat();
    if (seat) {
        if (seat.admission !== "admitted") return null;
        if (!(await inCallTogether(seat.meetingId, subjectId))) return null;
        return { id: "", isAdmin: false };
    }

    // Nobody at all, on an instance that publishes profiles. Answered as nobody,
    // exactly as a guest is: an empty id is on no friend list and in no privacy
    // list, so the only audience that lets it through is everybody - the same
    // rule the page itself applies. Without this a published profile is a page
    // of initials and the setting that published it reads as broken.
    if (await profilesArePublic()) return { id: "", isAdmin: false };
    return null;
}

export async function GET(request: Request, { params }: { params: Promise<{ userId: string }> }): Promise<Response> {
    const { userId } = await params;
    const viewer = await whoIsAsking(userId);
    if (!viewer) return new Response("Unauthorized", { status: 401 });

    // Somebody who keeps their photo to themselves, or to their friends. The
    // answer is the same one an account with no photo gives - the blank pixel,
    // with the component's initials showing through - rather than a refusal:
    // a 403 here would tell the person asking that there is one to see.
    //
    // A guest asks as nobody: an empty id is on no friend list and in no privacy
    // list, so the only audience that lets them through is everybody.
    const visible = await maySee(userId, "avatar", viewer);
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
