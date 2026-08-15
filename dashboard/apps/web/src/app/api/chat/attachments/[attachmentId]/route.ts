/**
 * One file somebody put on a message.
 *
 * Authorized by the conversation it is in, resolved before a single byte is
 * read: an attachment id in a URL is a request, and being able to guess one must
 * not be a way into a private channel.
 *
 * Served with everything that stops a browser treating somebody's upload as
 * something to run. `Content-Disposition` is inline for the formats the list
 * draws or plays and an attachment for everything else, which is the same
 * decision the message list makes about whether to show it - taken from the same
 * functions, so the two cannot disagree.
 *
 * Type matters as much as disposition here. `nosniff` is set on purpose, which
 * means a browser will do exactly what the header says and nothing else: a
 * recording served as `application/octet-stream` is not played, it is offered as
 * a file to save. So the formats with a player get their own type.
 */

import { requirePermission } from "@/lib/session";
import { channelAccess } from "@/lib/chat/access";
import {
    channelOfAttachment,
    isInlineImage,
    isPlayableMedia,
    readAttachment
} from "@/lib/chat/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A file on a message never changes - a new upload is a new row - so it can be
 *  kept for a long time. Private: it is one conversation's, not a proxy's. */
const CACHE = "private, max-age=86400, immutable";

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ attachmentId: string }> }
): Promise<Response> {
    const user = await requirePermission("chat.use");
    const { attachmentId } = await params;

    const channelId = await channelOfAttachment(attachmentId);
    // The same answer for "not there" and "not yours", so this cannot be used to
    // find out which conversations exist. They are logged apart, though: from
    // the outside a 404 is a 404, and from the inside "there is no such row",
    // "you are not in that conversation" and "the disk did not answer" are three
    // different afternoons.
    if (!channelId) {
        console.warn(`chat: attachment ${attachmentId} has no row`);
        return new Response(null, { status: 404 });
    }
    if (!(await channelAccess({ id: user.id }, channelId))) {
        console.warn(`chat: ${user.id} may not read attachment ${attachmentId}`);
        return new Response(null, { status: 404 });
    }

    const file = await readAttachment(attachmentId);
    if (!file) return new Response(null, { status: 404 });

    const shown = isInlineImage(file.contentType) || isPlayableMedia(file.contentType);
    return new Response(file.bytes as unknown as BodyInit, {
        headers: {
            "Content-Type": shown ? file.contentType : "application/octet-stream",
            "Content-Length": String(file.bytes.length),
            "Cache-Control": CACHE,
            // The bytes came from a person and are served from Polaris's own
            // origin: the browser must treat them as what they were declared to
            // be and nothing else, and must not be talked into running anything
            // found inside them.
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": `${shown ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`
        }
    });
}
