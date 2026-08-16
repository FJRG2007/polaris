/**
 * The picture on a space or a conversation: serving it, replacing it, removing it.
 *
 * The same shape as an account's face and an organization's, through the same
 * service and the same storage target - a picture is a picture, and a third way
 * of writing one would be a third place for the storage bug to live.
 *
 * Reading takes reaching the thing. Unlike an account's face, which anybody
 * signed in may draw, a space icon says which spaces exist: answering for one
 * somebody is not in would list the instance's rooms to anybody who guessed an
 * id. The blank pixel is the answer either way, so a refusal cannot be told from
 * "it has no picture".
 *
 * Writing takes being the one who runs it - the space's owner or an admin, the
 * group's creator. Not every member: a group photo that anybody can change is a
 * group photo that changes.
 */

import { prisma } from "@polaris/db";
import { requireUser } from "@/lib/session";
import { channelAccess, picturesAllowed, spaceAccess } from "@/lib/chat/access";
import { BLANK_AVATAR_ETAG, blankAvatarResponse } from "@/lib/avatar-blank";
import {
    deleteAvatar,
    MAX_AVATAR_BYTES,
    resolveChatAvatar,
    sniffImageMime,
    storeAvatar
} from "@/lib/avatar-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOO_BIG = `A photo has to be under ${Math.round(MAX_AVATAR_BYTES / (1024 * 1024))} MB`;

/** Kept and checked every time, like every other face - the tag makes it a 304,
 *  and a browser holding a picture that has since changed has no other way to
 *  find out. */
const CACHE = "private, no-cache";

/** A storage that did not answer is not the same statement as "there is no
 *  picture", so it is not cached as one. */
const NO_CACHE = "private, no-store";

type Kind = "space" | "channel";

function kindOf(raw: string): Kind | null {
    return raw === "space" || raw === "channel" ? raw : null;
}

export async function GET(
    request: Request,
    { params }: { params: Promise<{ kind: string; subjectId: string }> }
): Promise<Response> {
    const user = await requireUser();
    const { kind, subjectId } = await params;
    const what = kindOf(kind);
    if (!what) return blankAvatarResponse(NO_CACHE);
    if (!(await mayRead(user.id, what, subjectId))) return blankAvatarResponse(NO_CACHE);

    const picture = await resolveChatAvatar(what, subjectId);
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
        return new Response(null, {
            status: 304,
            headers: { ETag: picture.etag, "Cache-Control": CACHE }
        });
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
            // browser treats it as the image it was sniffed to be and nothing
            // else, and is not talked into running anything inside it.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": "inline"
        }
    });
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ kind: string; subjectId: string }> }
): Promise<Response> {
    const user = await requireUser();
    const { kind, subjectId } = await params;
    const what = kindOf(kind);
    if (!what) return new Response("Not found", { status: 404 });
    if (!(await mayWrite(user.id, what, subjectId))) {
        return new Response("That is not yours to change", { status: 403 });
    }

    if (!request.body) return new Response("Empty body", { status: 400 });
    // Content-Length is a claim like any other, so it only refuses the obviously
    // too big before anything is read; the real check is on the bytes that came.
    if (Number(request.headers.get("content-length") ?? "0") > MAX_AVATAR_BYTES) {
        return new Response(TOO_BIG, { status: 413 });
    }

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length === 0) return new Response("Empty body", { status: 400 });
    if (bytes.length > MAX_AVATAR_BYTES) return new Response(TOO_BIG, { status: 413 });

    // What the bytes are, not what the upload claimed they are.
    const mime = sniffImageMime(bytes);
    if (!mime) return new Response("That file is not a PNG, JPEG, WebP or GIF image", { status: 415 });

    try {
        await storeAvatar({ kind: what, id: subjectId }, bytes, mime);
        return Response.json({ ok: true });
    } catch (error) {
        console.error("avatars: could not store the chat picture:", error);
        return new Response(refusal(error, user.isAdmin), { status: 502 });
    }
}

export async function DELETE(
    _request: Request,
    { params }: { params: Promise<{ kind: string; subjectId: string }> }
): Promise<Response> {
    const user = await requireUser();
    const { kind, subjectId } = await params;
    const what = kindOf(kind);
    if (!what) return new Response("Not found", { status: 404 });
    if (!(await mayWrite(user.id, what, subjectId))) {
        return new Response("That is not yours to change", { status: 403 });
    }

    await deleteAvatar({ kind: what, id: subjectId });
    return Response.json({ ok: true });
}

/**
 * What to tell somebody whose photo would not save.
 *
 * It only gets this far when no storage would keep the file - the chosen one and
 * then this server - so it is an outage rather than a bad upload, and the
 * operator is the one person who can act on it. To everybody else the storage's
 * own words are noise with a hostname in them.
 */
function refusal(error: unknown, isAdmin: boolean): string {
    if (!isAdmin) return "Could not store that photo";
    return `Could not store that photo: ${error instanceof Error ? error.message : String(error)}`;
}

async function mayRead(userId: string, kind: Kind, id: string): Promise<boolean> {
    const actor = { id: userId };
    if (kind === "space") return (await spaceAccess(actor, id)) !== null;
    return (await channelAccess(actor, id)) !== null;
}

/**
 * Who may change it.
 *
 * A space: its owner, or somebody who administers it. A channel inside one: the
 * same people. A group message has no administrators at all - everybody in one
 * is equal in it - so the answer there is the person who started it, which is
 * what the ask was and what every messenger does.
 */
async function mayWrite(userId: string, kind: Kind, id: string): Promise<boolean> {
    const actor = { id: userId };
    if (kind === "space") {
        const access = await spaceAccess(actor, id);
        return access === "owner" || access === "admin";
    }

    const access = await channelAccess(actor, id);
    if (!access) return false;

    const channel = await prisma.chatChannel.findUnique({
        where: { id },
        select: { kind: true, createdById: true }
    });
    if (!channel) return false;
    return picturesAllowed({ ...channel, mayAdminister: access.mayAdminister }, userId);
}
