/**
 * The band across the top of an organization's page.
 *
 * The same arrangement as the mark beside it, for the same reasons: one URL
 * whatever the answer turns out to be, and a transparent pixel rather than a 404
 * for the organizations that have no banner - which is most of them - so a page
 * does not fire a failed request every time it opens, and the colour drawn
 * underneath shows through either way.
 *
 * Reading follows the organization's mark exactly: open to anybody signed in,
 * and to a reader with no session on an instance that publishes profiles, since
 * this is drawn on a page that is handed out. Nothing here is per-viewer - an
 * organization has one banner and everybody who reaches the page sees the same
 * one. Writing takes the organization's settings permission, and the
 * organization written to is the one in the URL rather than one named in a body,
 * so there is one id and it is checked.
 */

import { recordAudit } from "@/lib/audit-service";
import { apiUser } from "@/lib/api-session";
import { resolveSession } from "@/lib/session";
import { profilesArePublic } from "@/lib/profile-service";
import { requireOrgPermission } from "@/lib/orgs/org-service";
import { BLANK_AVATAR_ETAG, blankAvatarResponse } from "@/lib/avatar-blank";
import {
    deleteAvatar,
    MAX_AVATAR_BYTES,
    resolveOrgBanner,
    sniffImageMime,
    storeAvatar
} from "@/lib/avatar-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOO_BIG = `A banner has to be under ${Math.round(MAX_AVATAR_BYTES / (1024 * 1024))} MB`;

/** Kept and checked every time - see the avatar route, which explains why. */
const CACHE = "private, no-cache";

/** What a failure is cached as, which is not at all: a storage that did not
 *  answer is not the same statement as "there is no picture". */
const NO_CACHE = "private, no-store";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ orgId: string }> }
): Promise<Response> {
    if (!(await resolveSession()) && !(await profilesArePublic())) {
        return new Response("Unauthorized", { status: 401 });
    }
    const { orgId } = await params;

    const picture = await resolveOrgBanner(orgId);
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
    if (!bytes) return blankAvatarResponse(NO_CACHE);

    return new Response(bytes as BodyInit, {
        headers: {
            "Content-Type": picture.mime,
            "Content-Length": String(bytes.length),
            ETag: picture.etag,
            "Cache-Control": CACHE,
            // Uploaded by a person and served from Polaris's own origin: the
            // browser must treat these bytes as the image they were sniffed to
            // be and must not be talked into running anything found inside.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": "inline"
        }
    });
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ orgId: string }> }
): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const { orgId } = await params;
    const refused = await guard(user, orgId);
    if (refused) return refused;

    if (!request.body) return new Response("Empty body", { status: 400 });
    // Content-Length is a claim like any other, so it only refuses the obviously
    // too big before anything is read; the real check is on the bytes that came.
    if (Number(request.headers.get("content-length") ?? "0") > MAX_AVATAR_BYTES) {
        return new Response(TOO_BIG, { status: 413 });
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length === 0) return new Response("Empty body", { status: 400 });
    if (bytes.length > MAX_AVATAR_BYTES) return new Response(TOO_BIG, { status: 413 });

    const mime = sniffImageMime(bytes);
    if (!mime) return new Response("That file is not a PNG, JPEG, WebP or GIF image", { status: 415 });

    try {
        await storeAvatar({ kind: "orgBanner", id: orgId }, bytes, mime);
        await recordAudit({
            actorId: user.id,
            orgId,
            action: "org.banner.set",
            targetType: "org",
            targetId: orgId
        });
        return Response.json({ ok: true });
    } catch (error) {
        // The reason is for the operator's log; the person gets a sentence they
        // can act on, without the storage layer's paths in it.
        console.error("avatars: could not store the organization banner:", error);
        return new Response(
            user.isAdmin
                ? `Could not store that banner: ${error instanceof Error ? error.message : String(error)}`
                : "Could not store that banner",
            { status: 502 }
        );
    }
}

export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ orgId: string }> }
): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const { orgId } = await params;
    const refused = await guard(user, orgId);
    if (refused) return refused;

    await deleteAvatar({ kind: "orgBanner", id: orgId });
    await recordAudit({
        actorId: user.id,
        orgId,
        action: "org.banner.clear",
        targetType: "org",
        targetId: orgId
    });
    return Response.json({ ok: true });
}

/**
 * Whether this account may change the organization's banner.
 *
 * 404 rather than 403, matching every other organization surface: an
 * organization somebody has no part in must not be confirmable by poking at its
 * pictures.
 */
async function guard(user: { id: string; isAdmin: boolean }, orgId: string): Promise<Response | null> {
    try {
        await requireOrgPermission({ id: user.id, isAdmin: user.isAdmin }, orgId, "settings.manage");
        return null;
    } catch {
        return new Response(null, { status: 404 });
    }
}
