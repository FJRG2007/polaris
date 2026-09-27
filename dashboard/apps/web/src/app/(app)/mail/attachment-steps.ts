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
