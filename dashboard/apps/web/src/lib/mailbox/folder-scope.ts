/**
 * What a conversation row means when it is moved out of the folder it is listed in.
 *
 * The list draws conversations and names each one by its newest message in the
 * folder being looked at. Deleting, archiving or filing that row used to move
 * that one message and leave the rest of the conversation where it was - so the
 * row left the screen, the folder still held the older messages of the same
 * conversation, and the next list (or a reload) put the conversation straight
 * back. From the screen that is "I deleted it and it came back".
 *
 * So a move aimed at a row takes every message of that conversation that sits in
 * the same folder as the message that named it - which is exactly what the row
 * stood for in that folder. Messages of the conversation in other folders (Sent,
 * Archive) are left alone: the view was not showing them.
 */

interface Placed {
    readonly id: string;
    readonly threadId: string;
    readonly folderId: string;
}

/** The members of `candidates` that share a conversation and a folder with any
 *  message in `named`, plus `named` itself, each once. */
export function sameFolderSiblings<T extends Placed>(
    named: readonly T[],
    candidates: readonly T[]
): T[] {
    const places = new Set(named.map((message) => `${message.threadId}|${message.folderId}`));
    const out = new Map<string, T>();
    for (const message of named) out.set(message.id, message);
    for (const message of candidates) {
        if (places.has(`${message.threadId}|${message.folderId}`)) out.set(message.id, message);
    }
    return [...out.values()];
}
