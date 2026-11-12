/**
 * The picture a webhook message asked to post under (Discord's `avatar_url`),
 * fetched back through Polaris.
 *
 * Addressed by the message, never by a URL in the request, for the reason the
 * link-card picture is: a route that took the address would be an open fetch
 * proxy. The fetch is the vetted one (`lib/safe-fetch`), so an address that
 * resolves inside the network is refused, and only a raster picture of avatar
 * size is passed on. The reader's browser never contacts the remote site, so
 * it learns nothing about who read the message.
 */

import { prisma } from "@polaris/db";
import { fetchImage } from "@/lib/safe-fetch";
import { apiPermission } from "@/lib/api-session";
import { channelAccess } from "@/lib/chat/access";
import { MAX_AVATAR_BYTES, sniffImageMime } from "@/lib/avatar-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A picture under one message's address never changes. */
const CACHE_SECONDS = 24 * 60 * 60;

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ messageId: string }> }
): Promise<Response> {
    const user = await apiPermission("chat.use");
    if (user instanceof Response) return user;
    const { messageId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(messageId)) return new Response(null, { status: 404 });

    const row = await prisma.chatMessage.findUnique({
        where: { id: messageId },
        select: { channelId: true, authorAvatarUrl: true, deletedAt: true }
    });
    if (!row?.authorAvatarUrl || row.deletedAt) return new Response(null, { status: 404 });
    // The same answer for "not yours to read" as for "no picture".
    if (!(await channelAccess({ id: user.id }, row.channelId))) {
        return new Response(null, { status: 404 });
    }

    const image = await fetchImage(row.authorAvatarUrl, MAX_AVATAR_BYTES).catch(() => null);
    // What the bytes are, not what the remote site said: never an SVG or a page.
    const mime = image ? sniffImageMime(image.bytes) : null;
    if (!image || !mime) return new Response(null, { status: 404 });

    return new Response(Buffer.from(image.bytes), {
        headers: {
            "content-type": mime,
            "cache-control": `private, max-age=${CACHE_SECONDS}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox"
        }
    });
}
