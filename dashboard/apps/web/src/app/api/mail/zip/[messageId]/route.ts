/**
 * Every file on one message, as a single archive.
 *
 * Authorized before anything is read: the message is found narrowed by the
 * caller's own id, and one that is not theirs is the same 404 as one that does
 * not exist. The files stream through the same zip writer Drive's folder
 * download uses, fetched from the mail server one at a time as the writer
 * reaches them, so nothing is held in memory beyond the file being written.
 *
 * Always a download, never drawn: an archive is not something a browser renders,
 * and the same `nosniff` and sandboxing policy as a single attachment applies.
 */

import { apiPermission } from "@/lib/api-session";
import { createZipStream } from "@/lib/zip-stream";
import { MailAccessError } from "@/lib/mailbox/access";
import { attachmentZipPlan, attachmentZipSources } from "@/lib/mailbox/attachment-zip";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A safe ASCII fallback for the Content-Disposition header. */
function asciiFallback(name: string): string {
    return name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "attachments.zip";
}

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ messageId: string }> }
): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;
    const { messageId } = await params;
    if (!/^[0-9a-f-]{36}$/i.test(messageId)) return new Response("Not found", { status: 404 });

    let plan;
    try {
        plan = await attachmentZipPlan(user.id, messageId);
    } catch (caught) {
        if (caught instanceof MailAccessError) return new Response("Not found", { status: 404 });
        console.error("polaris: a mail archive could not be prepared:", caught);
        return new Response("Those files could not be gathered.", { status: 502 });
    }

    return new Response(createZipStream(attachmentZipSources(user.id, plan)), {
        status: 200,
        headers: {
            "content-type": "application/zip",
            "content-disposition": `attachment; filename="${asciiFallback(plan.archiveName)}"; filename*=UTF-8''${encodeURIComponent(plan.archiveName)}`,
            "x-content-type-options": "nosniff",
            "content-security-policy": "default-src 'none'; sandbox",
            "cache-control": "private, no-store"
        }
    });
}
