/**
 * An organization's photo: serving it, replacing it, and taking it down.
 *
 * Reading is open to anybody signed in, exactly as an account's face is - a
 * photo appears in a switcher and a roster, and gating it per organization would
 * mean a member of one seeing broken circles for another they can see the name
 * of anyway. Writing takes the organization's settings permission, and the
 * organization written to is the one in the URL rather than one named in a body,
 * so there is one id and it is checked.
 *
 * A route rather than a server action because the body is a file, and because
 * what the bytes are has to be decided from the bytes: a declared content type is
 * a claim, and the type a file is served back as is what a browser acts on.
 */

import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { requireOrgPermission } from "@/lib/orgs/org-service";
import {
    deleteAvatar,
    MAX_AVATAR_BYTES,
    resolveOrgAvatar,
    sniffImageMime,
    storeAvatar
} from "@/lib/avatar-service";
import { BLANK_AVATAR_ETAG, blankAvatarResponse } from "@/lib/avatar-blank";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOO_BIG = `A photo has to be under ${Math.round(MAX_AVATAR_BYTES / (1024 * 1024))} MB`;

/** Five minutes, revalidated after that - the same deal an account's face gets,
 *  and for the same reason: it is drawn dozens of times on one screen. */
const CACHE = "private, max-age=300, must-revalidate";

export async function GET(request: Request, { params }: { params: Promise<{ orgId: string }> }): Promise<Response> {
    await requireUser();
    const { orgId } = await params;

    const picture = await resolveOrgAvatar(orgId);
    // Cached too: an organization with no picture is the common case, and
    // without this every one of them is asked for again on every screen. A
    // transparent pixel rather than a 404, for the same reason an account's
    // face is - see lib/avatar-blank.
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
    if (!bytes) return blankAvatarResponse(CACHE);

    return new Response(bytes as BodyInit, {
        headers: {
            "Content-Type": picture.mime,
            "Content-Length": String(bytes.length),
            ETag: picture.etag,
            "Cache-Control": CACHE,
            // These bytes were uploaded by a person and are served from Polaris's
            // own origin: the browser must treat them as the image they were
            // sniffed to be and nothing else.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": "inline"
        }
    });
}

export async function POST(request: Request, { params }: { params: Promise<{ orgId: string }> }): Promise<Response> {
    const user = await requireUser();
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
        await storeAvatar({ kind: "org", id: orgId }, bytes, mime);
        await recordAudit({ actorId: user.id, orgId, action: "org.photo.set", targetType: "org", targetId: orgId });
        return Response.json({ ok: true });
    } catch (error) {
        // The reason is for the operator's log; the person gets a sentence they
        // can act on, without the storage layer's paths in it.
        console.error("avatars: could not store the organization photo:", error);
        return new Response("Could not store that photo", { status: 502 });
    }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ orgId: string }> }): Promise<Response> {
    const user = await requireUser();
    const { orgId } = await params;
    const refused = await guard(user, orgId);
    if (refused) return refused;

    await deleteAvatar({ kind: "org", id: orgId });
    await recordAudit({ actorId: user.id, orgId, action: "org.photo.clear", targetType: "org", targetId: orgId });
    return Response.json({ ok: true });
}

/**
 * Whether this account may change the organization's photo, as a response to
 * return or nothing at all.
 *
 * 404 rather than 403 for both cases, matching every other organization surface:
 * an organization somebody has no part in must not be confirmable by poking at
 * its photo.
 */
async function guard(user: { id: string; isAdmin: boolean }, orgId: string): Promise<Response | null> {
    try {
        await requireOrgPermission({ id: user.id, isAdmin: user.isAdmin }, orgId, "settings.manage");
        return null;
    } catch {
        return new Response(null, { status: 404 });
    }
}
