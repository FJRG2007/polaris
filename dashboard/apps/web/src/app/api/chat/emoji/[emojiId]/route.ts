/**
 * One of a space's emoji, as a picture.
 *
 * Reading takes reaching the space, the same rule as the space's icon: an emoji
 * says which space it is from, and answering for somebody who is not in it would
 * let anybody holding an id look into a room. A refusal and "no such emoji" are
 * the same 404, so the one cannot be told from the other.
 *
 * The bytes under an id never change - a new picture is a new emoji - so a
 * browser that has one keeps it for good and never asks again. Private, because
 * whether somebody may see it is a fact about them.
 */

import { apiUser } from "@/lib/api-session";
import { readSpaceEmoji } from "@/lib/chat/custom-emoji";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ emojiId: string }> }
): Promise<Response> {
    const user = await apiUser();
    if (user instanceof Response) return user;
    const { emojiId } = await params;
    if (!UUID.test(emojiId)) return new Response("Not found", { status: 404 });

    const picture = await readSpaceEmoji({ id: user.id }, emojiId.toLowerCase());
    if (!picture) {
        return new Response("Not found", {
            status: 404,
            headers: { "Cache-Control": "private, no-store" }
        });
    }

    return new Response(picture.bytes as BodyInit, {
        headers: {
            "Content-Type": picture.mime,
            "Content-Length": String(picture.bytes.length),
            "Cache-Control": "private, max-age=31536000, immutable",
            // Uploaded by a person and served from Polaris's own origin: the
            // browser treats it as the image it was sniffed to be and nothing
            // else.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": "inline"
        }
    });
}
