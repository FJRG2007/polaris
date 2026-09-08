/**
 * A file dropped into the composer.
 *
 * A route rather than a server action because it carries bytes: a server action
 * would round-trip the whole file through the action encoding, and the composer
 * wants a progress bar and the ability to cancel one upload without losing the
 * message being written.
 *
 * The size ceiling is enforced twice - by the declared length before anything is
 * read, and by what actually arrived - because the first is what the sender
 * claimed and the second is what they sent.
 *
 * Which ceiling depends on what the file is for. An attachment is bounded by
 * what a mail server will take; an archive being imported is read here and
 * appended message by message, never sent anywhere as one file, so holding it to
 * the attachment limit refused every real export with a sentence about mail
 * servers that had nothing to do with it.
 */

import { apiPermission } from "@/lib/api-session";
import {
    MAX_ARCHIVE_BYTES,
    MAX_ATTACHMENT_BYTES,
    removeUpload,
    storeUpload
} from "@/lib/mailbox/uploads";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How big a file of this kind may be, and what to say when it is not. */
function ceilingFor(kind: string): { max: number; refusal: string } {
    return kind === "archive"
        ? {
              max: MAX_ARCHIVE_BYTES,
              refusal: `That archive is larger than ${Math.round(MAX_ARCHIVE_BYTES / (1024 * 1024))} MB, which is more than Polaris can read in one go. Split it and bring the parts in one after another.`
          }
        : {
              max: MAX_ATTACHMENT_BYTES,
              refusal: "That file is bigger than most mail servers will accept."
          };
}

export async function POST(request: Request): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;

    // Said in the query rather than the form, because the declared length is
    // refused before a byte of the body is read.
    const ceiling = ceilingFor(new URL(request.url).searchParams.get("kind") ?? "");
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > ceiling.max * 1.1) {
        return Response.json({ error: ceiling.refusal }, { status: 413 });
    }

    let form: FormData;
    try {
        form = await request.formData();
    } catch {
        return Response.json({ error: "That upload did not arrive." }, { status: 400 });
    }
    const file = form.get("file");
    if (!(file instanceof File))
        return Response.json({ error: "No file was sent." }, { status: 400 });

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes.length === 0) return Response.json({ error: "That file is empty." }, { status: 400 });
    if (bytes.length > ceiling.max) {
        return Response.json({ error: ceiling.refusal }, { status: 413 });
    }

    try {
        const stored = await storeUpload(
            user.id,
            {
                name: file.name,
                type: file.type,
                bytes
            },
            { inline: form.get("inline") === "1", maxBytes: ceiling.max }
        );
        return Response.json({ upload: stored });
    } catch (caught) {
        console.error("polaris: a mail attachment could not be stored:", caught);
        return Response.json({ error: "That file could not be attached." }, { status: 500 });
    }
}

/** Take a file back off a message being written. */
export async function DELETE(request: Request): Promise<Response> {
    const user = await apiPermission("mail.use");
    if (user instanceof Response) return user;
    const uploadId = new URL(request.url).searchParams.get("id") ?? "";
    if (!uploadId) return Response.json({ error: "Nothing was named." }, { status: 400 });
    await removeUpload(user.id, uploadId);
    return Response.json({});
}
