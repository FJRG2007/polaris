/**
 * Moving between a message's attachments without closing the viewer.
 *
 * The run is the files the list under the message offers to open, by the same
 * test, so the arrows never reach one the list would not have opened and never
 * skip one it would. Pictures drawn inside the body are not attachments to
 * anybody reading it, and are left out the way the list leaves them out. The
 * ends are ends - Right on the last file does nothing rather than wrapping to
 * the first, which is what makes "5 of 5" mean the last one.
 *
 * Pure, so the order can be checked without a screen.
 */

import { isViewable } from "@/app/(app)/drive/viewer/kind";

/** What this needs to know about an attachment. */
export interface AttachmentLike {
    readonly id: string;
    readonly name: string;
    readonly inline: boolean;
}

/** The attachments that open in the viewer, in the order the message lists them. */
export function openableAttachments<T extends AttachmentLike>(files: readonly T[]): T[] {
    return files.filter((file) => !file.inline && isViewable(file.name));
}

/** Where one file is in the run, or -1 when it is not in it. */
export function positionOf(files: readonly AttachmentLike[], fileId: string): number {
    return files.findIndex((file) => file.id === fileId);
}

/** The file one step away, or null at either end or for a file not in the run. */
export function stepFrom<T extends AttachmentLike>(
    files: readonly T[],
    fileId: string,
    by: -1 | 1
): T | null {
    const at = positionOf(files, fileId);
    if (at === -1) return null;
    return files[at + by] ?? null;
}

/** A file as the conversation's own list shows it: which message it came on. */
export interface ConversationFile {
    readonly id: string;
    readonly name: string;
    readonly size: number;
    readonly inline: boolean;
    readonly messageId: string;
    readonly sentAt: string;
    readonly from: string;
}

/**
 * Every file attached anywhere in a conversation, newest first, each once.
 *
 * A long thread folds its middle away and opens only the newest message, so a
 * contract sent twenty messages ago is three clicks deep - which reads as the
 * file being gone. This is the list that goes above the messages instead.
 *
 * Once, because the same file turns up twice for nearly everything somebody
 * sends: the copy in Sent, and the copy that comes back in the other person's
 * reply or on a second mailbox. Two files with the same name and the same size
 * are taken for one, and the newest is kept, since that is the one the
 * conversation is about now.
 */
export function conversationFiles(
    messages: readonly {
        readonly id: string;
        readonly sentAt: string;
        readonly from: readonly { readonly name?: string | null; readonly address: string }[];
        readonly attachments: readonly {
            readonly id: string;
            readonly name: string;
            readonly size: number;
            readonly inline: boolean;
        }[];
    }[]
): ConversationFile[] {
    const seen = new Set<string>();
    const out: ConversationFile[] = [];
    const newestFirst = [...messages].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
    for (const message of newestFirst) {
        const sender = message.from[0];
        const from = sender ? sender.name || sender.address : "";
        for (const file of message.attachments) {
            if (file.inline) continue;
            const key = `${file.name.toLowerCase()}\u0000${file.size}`;
            if (seen.has(key)) continue;
            seen.add(key);
            out.push({
                id: file.id,
                name: file.name,
                size: file.size,
                inline: false,
                messageId: message.id,
                sentAt: message.sentAt,
                from
            });
        }
    }
    return out;
}
