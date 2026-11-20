/**
 * The sender's own copy of the files they just sent, for as long as it is drawn.
 *
 * A message with a picture in it is on the sender's screen from the moment Send
 * is pressed, drawn from the file in this browser rather than from the server.
 * When it lands, the message the server answers with takes that row's place -
 * same row, same picture element - and keeps drawing the local copy until the
 * server's has been fetched and decoded, so the picture goes sharp where it is
 * instead of blinking to a blur and back. Only then is the local address let go.
 */

import { isInlineImage, typeOfFile } from "@/lib/mime";

/** The address of each file, made once: the row that is uploading and the row
 *  it becomes ask for the same file and must get the same address. */
const addresses = new WeakMap<File, string>();

export function localUrl(file: File): string {
    const known = addresses.get(file);
    if (known) return known;
    const made = URL.createObjectURL(file);
    addresses.set(file, made);
    return made;
}

/** The address a file already has, without making one: a landed picture that
 *  let its local copy go draws the server's from then on. */
export function heldLocalUrl(file: File): string | undefined {
    return addresses.get(file);
}

/** Let one file's address go. Drawing it again makes a new one. */
export function releaseLocal(file: File): void {
    const known = addresses.get(file);
    if (!known) return;
    addresses.delete(file);
    URL.revokeObjectURL(known);
}

/** One file of a message that has landed, under the key its attachment had
 *  while it was going - see `outgoingFileId`. */
export interface LandedFile {
    readonly file: File;
    readonly key: string;
}

export interface Landed {
    /** The key of the row it was drawn under while it went. */
    readonly key: string;
    /** Its files, in the order the message carries them. */
    readonly files: readonly LandedFile[];
}

/** Bounded: one entry per message sent with files from this tab. */
const MOST_LANDED = 100;
const landed = new Map<string, Landed>();

/** Pictures still drawn from the local copy, which the picture lets go itself
 *  once the server's has arrived - see `KeepableImage`. */
const handedOver = new WeakSet<File>();

function isPicture(file: File): boolean {
    return isInlineImage(typeOfFile(file.type, file.name));
}

/** A message with files has landed as `messageId`. */
export function rememberLanded(messageId: string, entry: Landed): void {
    landed.delete(messageId);
    landed.set(messageId, entry);
    for (const one of entry.files) if (isPicture(one.file)) handedOver.add(one.file);
    while (landed.size > MOST_LANDED) {
        const oldest = landed.keys().next().value as string;
        for (const one of landed.get(oldest)?.files ?? []) releaseLocal(one.file);
        landed.delete(oldest);
    }
}

/** What a message sent from this tab was drawn as while it went. */
export function landedAs(messageId: string): Landed | undefined {
    return landed.get(messageId);
}

/**
 * A message on its way has left the screen: sent, given up on, or stopped.
 * Every address it held goes, except a picture the landed message is still
 * drawing from it.
 */
export function releaseFiles(files: readonly File[]): void {
    for (const file of files) if (!handedOver.has(file)) releaseLocal(file);
}
