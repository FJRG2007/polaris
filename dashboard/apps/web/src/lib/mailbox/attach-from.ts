/**
 * Attaching to a message something that is not on the reader's machine.
 *
 * The getting is shared with every other screen in Polaris that accepts a file;
 * what is here is only what mail does with the bytes afterwards, which is to
 * keep them as a pending upload so the size ceiling, where they are stored, and
 * the sweep that removes the ones a draft never sent are all the one
 * implementation the drag-and-drop already uses.
 */

import { prisma } from "@polaris/db";
import { readAttachment } from "./messages";
import { storeUpload, MAX_ATTACHMENT_BYTES, type StoredUpload } from "./uploads";
import { AttachRefused, fileFromAddress, fileFromDrive } from "@/lib/attachments/from-elsewhere";

export { AttachRefused };

/**
 * The files on a message being forwarded, carried onto the forward.
 *
 * A forward that arrives without the invoice it was forwarding is the commonest
 * way that feature fails somebody, and the bytes are one fetch away on the mail
 * server this message came from. Each is read through the same owner-narrowed
 * reader the download button uses and kept as a pending upload, so the forward
 * sends them, the composer can remove one, and an abandoned forward is swept
 * like any other draft's files.
 *
 * Pictures the HTML draws by Content-Id are left behind: a forward quotes the
 * plain text, so nothing in it refers to them, and they would arrive as a pile
 * of unexplained images. A file that cannot be fetched or is over the ceiling
 * is named in `skipped` rather than failing the rest.
 */
export async function attachFromMessage(
    userId: string,
    messageId: string
): Promise<{ uploads: StoredUpload[]; skipped: string[] }> {
    const files = await prisma.mailAttachment.findMany({
        where: { messageId, inline: false, message: { account: { userId } } },
        select: { id: true, name: true, size: true },
        orderBy: { part: "asc" }
    });
    const uploads: StoredUpload[] = [];
    const skipped: string[] = [];
    for (const file of files) {
        if (Number(file.size) > MAX_ATTACHMENT_BYTES) {
            skipped.push(file.name);
            continue;
        }
        try {
            const read = await readAttachment(userId, file.id);
            uploads.push(
                await storeUpload(userId, {
                    name: read.name,
                    type: read.contentType,
                    bytes: new Uint8Array(read.bytes)
                })
            );
        } catch (caught) {
            console.error("polaris: a forwarded attachment could not be carried:", caught);
            skipped.push(file.name);
        }
    }
    return { uploads, skipped };
}

/** A file on one of this reader's storages, attached. */
export async function attachFromDrive(
    userId: string,
    connectionId: string,
    path: string
): Promise<StoredUpload> {
    return storeUpload(
        userId,
        await fileFromDrive(userId, connectionId, path, MAX_ATTACHMENT_BYTES)
    );
}

/** A file at an address somebody pasted, attached. */
export async function attachFromAddress(userId: string, address: string): Promise<StoredUpload> {
    return storeUpload(userId, await fileFromAddress(address, MAX_ATTACHMENT_BYTES));
}
