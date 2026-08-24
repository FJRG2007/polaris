/**
 * A file somebody put into a call, back out.
 *
 * Proved by a seat, and by the file's own meeting rather than the one named in
 * the URL: an id in a path is what the caller wants to be true, and the row is
 * what is true. Without that check the meeting in the address would be decoration
 * and any seat anywhere would open any file.
 *
 * Only an image is served as itself. Everything else is `application/octet-stream`
 * and a download, because an inline file from an untrusted source is the browser
 * being asked to interpret bytes somebody chose - which is how a call ends up
 * running something.
 */

import { resolveSeat } from "@/lib/chat/meeting-seat";
import { isMeetingImage, meetingOfFile, readMeetingFile } from "@/lib/chat/meeting-files";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Kept by the browser that fetched it and by nothing in between.
 *
 * A file in a call is written once and never changed, so it is worth caching for
 * as long as the call lasts. Private, because it is served to one seat rather
 * than to the world, and short, because the bytes are deleted when the call ends
 * and a browser holding them for a day would be holding what nobody else can
 * reach any more.
 */
const CACHE = "private, max-age=300";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ meetingId: string; attachmentId: string }> }
): Promise<Response> {
    const { meetingId, attachmentId } = await params;

    const seat = await resolveSeat(meetingId);
    if (!seat || seat.admission !== "admitted") {
        return new Response("Unauthorized", { status: 401 });
    }
    // The file's own meeting, from the row. A seat in this call opens the files
    // of this call and no others.
    if ((await meetingOfFile(attachmentId)) !== meetingId) {
        return new Response("Not found", { status: 404 });
    }

    const file = await readMeetingFile(attachmentId);
    // The row said there was a file and the bytes did not arrive: a storage that
    // moved, a share that is not answering, or a call whose files have already
    // been cleared. Gone rather than broken, which is what it is.
    if (!file) return new Response("Gone", { status: 410 });

    const asFile = new URL(request.url).searchParams.get("download") === "1";
    const shown = !asFile && isMeetingImage(file.contentType);

    return new Response(file.bytes as unknown as BodyInit, {
        headers: {
            "Content-Type": shown ? file.contentType : "application/octet-stream",
            "Content-Length": String(file.bytes.length),
            "Cache-Control": CACHE,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "Content-Disposition": `${shown ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`
        }
    });
}
