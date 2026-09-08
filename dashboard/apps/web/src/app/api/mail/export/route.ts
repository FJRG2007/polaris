/**
 * Somebody's mail, handed back.
 *
 * `?messageId=` gives one message as the mail server holds it - the real bytes,
 * every header - and `?accountId=` gives a whole mailbox as mbox, built from
 * what Polaris has cached and streamed rather than assembled. The second one can
 * be hundreds of megabytes, which is the whole reason it streams: building an
 * archive in memory to answer one request is how a dashboard falls over while
 * somebody is watching it.
 *
 * Everything is served as a download with nothing allowed to run. This is
 * content from outside - it is the whole point of it - and an archive rendered
 * on this origin would be somebody else's markup on somebody else's session.
 *
 * Authorized before a byte is read, and narrowed by the caller's own id inside
 * the query rather than checked afterwards, exactly like the attachment route
 * beside it.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { apiPermission } from "@/lib/api-session";
import { MailAccessError } from "@/lib/mailbox/access";
import { emlFilename, exportMbox, messageSource } from "@/lib/mailbox/export";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** A filename, safe to put in a header: a name from outside can carry quotes and
 *  newlines, and a newline in a response header is a header somebody else
 *  wrote. */
function headerSafe(name: string): string {
    return (
        name
            .replace(/[\r\n"\\]/g, " ")
            .slice(0, 200)
            .trim() || "mail"
    );
}

function download(name: string): Record<string, string> {
    return {
        "content-type": "application/octet-stream",
        "content-disposition": `attachment; filename="${headerSafe(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "cache-control": "private, no-store"
    };
}

export async function GET(request: Request): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    const asked = new URL(request.url).searchParams;
    const messageId = asked.get("messageId") ?? "";
    const accountId = asked.get("accountId") ?? "";
    const folderId = asked.get("folderId") ?? "";

    try {
        if (messageId) {
            const row = await prisma.mailMessage.findFirst({
                where: { id: messageId, account: { userId: user.id } },
                select: { subject: true, sentAt: true }
            });
            if (!row) return new Response("Not found", { status: 404 });
            const bytes = await messageSource(user.id, messageId);
            if (!bytes) return new Response("Not found", { status: 404 });
            return new Response(new Uint8Array(bytes), {
                headers: {
                    ...download(emlFilename(row.subject, row.sentAt)),
                    "content-length": String(bytes.length)
                }
            });
        }

        if (!accountId) return new Response("Nothing was asked for", { status: 400 });

        // The mailbox is resolved before the stream starts, so a refusal is a
        // refusal rather than a downloaded file that turns out to be an error
        // message with a `.mbox` on the end.
        const account = await prisma.mailAccount.findFirst({
            where: { id: accountId, userId: user.id },
            select: { address: true }
        });
        if (!account) return new Response("Not found", { status: 404 });
        if (folderId) {
            const folder = await prisma.mailFolder.findFirst({
                where: { id: folderId, accountId, account: { userId: user.id } },
                select: { id: true }
            });
            if (!folder) return new Response("Not found", { status: 404 });
        }

        const encoder = new TextEncoder();
        const stream = new ReadableStream<Uint8Array>({
            async start(controller) {
                try {
                    for await (const entry of exportMbox(user.id, {
                        accountId,
                        folderId: folderId || null
                    })) {
                        controller.enqueue(encoder.encode(entry));
                    }
                    controller.close();
                } catch (caught) {
                    // The download stops short. Nothing useful can be said at
                    // this point - the headers have gone - so it is logged here
                    // and the file the browser keeps is simply incomplete.
                    console.error("polaris: a mail export stopped:", caught);
                    controller.error(caught);
                }
            }
        });

        return new Response(stream, {
            headers: download(core.mboxFilename(account.address, new Date()))
        });
    } catch (caught) {
        if (caught instanceof MailAccessError) return new Response("Not found", { status: 404 });
        console.error("polaris: a mail export could not be made:", caught);
        return new Response("That could not be exported.", { status: 502 });
    }
}
