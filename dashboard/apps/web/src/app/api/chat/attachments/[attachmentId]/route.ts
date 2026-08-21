/**
 * One file somebody put on a message.
 *
 * Authorized by the conversation it is in, resolved before a single byte is
 * read: an attachment id in a URL is a request, and being able to guess one must
 * not be a way into a private channel.
 *
 * Served with everything that stops a browser treating somebody's upload as
 * something to run. `Content-Disposition` is inline for the formats the list
 * draws, plays, or hands to the browser's own viewer, and an attachment for
 * everything else - the same decision the message list makes about whether to
 * show it, taken from the same functions, so the two cannot disagree.
 *
 * Type matters as much as disposition here. `nosniff` is set on purpose, which
 * means a browser will do exactly what the header says and nothing else: a
 * recording served as `application/octet-stream` is not played, it is offered as
 * a file to save. So the formats with a player get their own type.
 */

import { rangeOf } from "@/lib/http-range";
import { requirePermission } from "@/lib/session";
import { channelAccess } from "@/lib/chat/access";
import {
    channelOfAttachment,
    diagnoseAttachment,
    isInlineDocument,
    isInlineImage,
    isPlayableMedia,
    readAttachment,
    readAttachmentPoster
} from "@/lib/chat/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A file on a message never changes - a new upload is a new row - so it can be
 *  kept for a long time. Private: it is one conversation's, not a proxy's. */
const CACHE = "private, max-age=86400, immutable";

export async function GET(
    request: Request,
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

    // The still, when that is what was asked for. Its own answer rather than its
    // own route: the question "may this reader see this attachment" has already
    // been settled above, and a second route would settle it a second way.
    if (new URL(request.url).searchParams.get("poster") === "1") {
        const poster = await readAttachmentPoster(attachmentId);
        if (!poster) return new Response(null, { status: 404 });
        return new Response(poster as unknown as BodyInit, {
            headers: {
                "Content-Type": "image/jpeg",
                "Content-Length": String(poster.length),
                "Cache-Control": CACHE,
                "X-Content-Type-Options": "nosniff",
                "Content-Security-Policy": "default-src 'none'; sandbox",
                "Content-Disposition": "inline"
            }
        });
    }

    const file = await readAttachment(attachmentId);
    // Gone rather than missing, and said out loud. Access has already been
    // proved by this point, so there is nothing left to withhold - and the two
    // are not the same thing to whoever is looking at it: "there is no such
    // attachment" sends somebody to the browser, and "the storage this instance
    // writes to did not give it back" sends them to the disk, which is where it
    // is.
    if (!file) {
        // Asked at the moment somebody hits it, and answered to their face when
        // they are the one who can act on it. An operator should not have to go
        // and find a log to learn which disk lost their files.
        const detail = user.isAdmin ? await diagnoseAttachment(attachmentId) : "";
        console.error(`chat: attachment ${attachmentId} is gone - ${detail || "(not diagnosed)"}`);
        return Response.json(
            {
                error: "This file is not on the storage Polaris keeps uploads on. It was written and is no longer there.",
                detail
            },
            { status: 410 }
        );
    }

    // Asked for as a file rather than to be looked at or played. The menus that
    // offer "download" say so here as well as on the anchor, so what the browser
    // does with it does not rest on an attribute alone.
    const asFile = new URL(request.url).searchParams.get("download") === "1";
    const shown =
        !asFile &&
        (isInlineImage(file.contentType) ||
            isPlayableMedia(file.contentType) ||
            isInlineDocument(file.contentType));

    // What a player asks for when somebody drags the bar. Answered, and said to
    // be answerable, because a browser that is not offered ranges will not let
    // anybody seek at all: the bar snaps back to where it was and the video
    // reads as broken. The bytes are already in hand, so a range is a slice.
    const range = asFile ? null : rangeOf(request.headers.get("range"), file.bytes.length);
    if (range === "unsatisfiable") {
        return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${file.bytes.length}`, "Accept-Ranges": "bytes" }
        });
    }
    const body = range ? file.bytes.subarray(range.from, range.to + 1) : file.bytes;

    return new Response(body as unknown as BodyInit, {
        status: range ? 206 : 200,
        headers: {
            "Content-Type": shown ? file.contentType : "application/octet-stream",
            "Content-Length": String(body.length),
            "Accept-Ranges": "bytes",
            ...(range
                ? { "Content-Range": `bytes ${range.from}-${range.to}/${file.bytes.length}` }
                : {}),
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
