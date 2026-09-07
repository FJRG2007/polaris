/**
 * Attaching to a message something that is not on the reader's machine.
 *
 * The getting is shared with every other screen in Polaris that accepts a file;
 * what is here is only what mail does with the bytes afterwards, which is to
 * keep them as a pending upload so the size ceiling, where they are stored, and
 * the sweep that removes the ones a draft never sent are all the one
 * implementation the drag-and-drop already uses.
 */

import { storeUpload, MAX_ATTACHMENT_BYTES, type StoredUpload } from "./uploads";
import { AttachRefused, fileFromAddress, fileFromDrive } from "@/lib/attachments/from-elsewhere";

export { AttachRefused };

/** A file on one of this reader's storages, attached. */
export async function attachFromDrive(
    userId: string,
    connectionId: string,
    path: string
): Promise<StoredUpload> {
    return storeUpload(userId, await fileFromDrive(userId, connectionId, path, MAX_ATTACHMENT_BYTES));
}

/** A file at an address somebody pasted, attached. */
export async function attachFromAddress(userId: string, address: string): Promise<StoredUpload> {
    return storeUpload(userId, await fileFromAddress(address, MAX_ATTACHMENT_BYTES));
}
