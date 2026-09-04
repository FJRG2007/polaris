/**
 * One file that was on a reported message.
 *
 * Its own route rather than the attachment one, and not as a convenience. That
 * route authorizes by the conversation, which is right everywhere else and wrong
 * here: an administrator answering a report about a direct message cannot reach
 * that conversation, correctly, because administering an instance is not being
 * in somebody's private messages. So they could read the report and not see the
 * picture it was about - which, for the commonest kind of report, is the whole
 * of it.
 *
 * What they can see is what was handed to them. The report is the handover, and
 * the gate here is the same one that opens the queue: an administrator, and
 * nobody else. Addressed by report and file together, so an id on its own
 * reaches nothing and a file cannot be read through a report it does not belong
 * to.
 *
 * Served with the same headers the attachment route uses, for the same reason:
 * these bytes came from a person, and a moderation screen is the last place that
 * should be talked into running something found inside them.
 */

import { readReportFile } from "@/lib/chat/report-files";
import { apiAdmin } from "@/lib/api-session";
import { isInlineImage, isPlayableMedia } from "@/lib/chat/attachments";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A reported file never changes - the row is a copy taken at one moment - so it
 *  can be kept. Private: it is one administrator's view of one report. */
const CACHE = "private, max-age=3600";

export async function GET(
    request: Request,
    { params }: { params: Promise<{ reportId: string; fileId: string }> }
): Promise<Response> {
    const refused = await apiAdmin();
    if (refused instanceof Response) return refused;
    const { reportId, fileId } = await params;

    const file = await readReportFile(reportId, fileId);
    // The same answer for "not there" and "not that report's", so this cannot be
    // used to find out which files exist.
    if (!file) {
        return Response.json({ error: "That file is no longer there" }, { status: 410 });
    }

    const asFile = new URL(request.url).searchParams.get("download") === "1";
    const shown =
        !asFile && (isInlineImage(file.contentType) || isPlayableMedia(file.contentType));
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
