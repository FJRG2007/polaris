/**
 * Putting up your own profile banner, and taking it down again.
 *
 * Always your own: the account written to is the one in the session, never one
 * named in the request, so there is no id here to tamper with.
 *
 * A route rather than a server action because the body is a file, and because
 * what the bytes are has to be decided from the bytes. The declared content type
 * is a claim; the type the picture is later served as is what a browser acts on,
 * so the two are not allowed to be the same thing.
 */

import { deleteAvatar, MAX_AVATAR_BYTES, sniffImageMime, storeAvatar } from "@/lib/avatar-service";
import { apiUser } from "@/lib/api-session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const TOO_BIG = `A banner has to be under ${Math.round(MAX_AVATAR_BYTES / (1024 * 1024))} MB`;

export async function POST(request: Request): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    if (!request.body) return new Response("Empty body", { status: 400 });

    // Content-Length is a claim like any other, so it only refuses the obviously
    // too big before anything is read; the real check is on the bytes that came.
    const declared = Number(request.headers.get("content-length") ?? "0");
    if (declared > MAX_AVATAR_BYTES) return new Response(TOO_BIG, { status: 413 });

    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.length === 0) return new Response("Empty body", { status: 400 });
    if (bytes.length > MAX_AVATAR_BYTES) return new Response(TOO_BIG, { status: 413 });

    const mime = sniffImageMime(bytes);
    if (!mime) return new Response("That file is not a PNG, JPEG, WebP or GIF image", { status: 415 });

    try {
        await storeAvatar({ kind: "banner", id: user.id }, bytes, mime);
        return Response.json({ ok: true });
    } catch (error) {
        // The reason is for the operator's log; the person gets a sentence they
        // can act on, without the storage layer's paths in it.
        console.error("banners: could not store the picture:", error);
        return new Response(
            user.isAdmin
                ? `Could not store that picture: ${error instanceof Error ? error.message : String(error)}`
                : "Could not store that picture",
            { status: 502 }
        );
    }
}

export async function DELETE(): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    await deleteAvatar({ kind: "banner", id: user.id });
    return Response.json({ ok: true });
}
