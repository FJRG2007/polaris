/**
 * A conversation's sealed scheduled messages, as the list above the box shows
 * them (docs/chat-e2ee-mls.md, "Sealed scheduled messages").
 *
 * The server holds a sealed one as a seal and nothing else, so its words are
 * opened here, on the writer's device, and one whose conversation rekeyed after
 * it was written is sealed again here too - the server never sends a seal made
 * under an older epoch, since somebody removed since then holds that key.
 */

import type { ScheduledShown } from "./scheduled-bar";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import type { ScheduledMessageView } from "@/lib/chat/scheduled";

/** The rows that carry a seal this device can try, in the shape `sealed-chat` takes. */
function withSeal(rows: readonly ScheduledMessageView[]): { id: string; sealed: NonNullable<ScheduledMessageView["sealed"]> }[] {
    return rows.flatMap((row) => (row.sealed ? [{ id: row.id, sealed: row.sealed }] : []));
}

/**
 * Seal again every row here whose conversation moved past the epoch it was
 * sealed in. Answers how many were; a row this device cannot open is left as
 * it was, and the list says it is waiting for another device.
 */
export async function resealDue(channelId: string, rows: readonly ScheduledMessageView[]): Promise<number> {
    const due = withSeal(rows.filter((row) => row.resealDue));
    if (!due.length) return 0;
    return sealedChat.resealScheduled(channelId, due).catch((caught: unknown) => {
        console.warn("polaris: scheduled messages were not sealed again:", caught);
        return 0;
    });
}

/**
 * The rows with each sealed one's words and files filled in from its seal.
 * One that does not open here - the device that sealed it is gone, or this one
 * never held the key it was sealed under - is marked `unopened`, never shown
 * empty as though it said nothing.
 */
export async function openedScheduled(channelId: string, rows: readonly ScheduledMessageView[]): Promise<ScheduledShown[]> {
    const sealedRows = rows.filter((row) => row.sealed !== undefined);
    if (!sealedRows.length) return [...rows];
    const opened = sealedChat.sealedChatActive()
        ? await sealedChat.openScheduled(channelId, withSeal(sealedRows)).catch(() => new Map<string, sealedChat.SealedContent | null>())
        : new Map<string, sealedChat.SealedContent | null>();
    return rows.map((row) => {
        if (row.sealed === undefined) return row;
        const content = opened.get(row.id);
        if (!content) return { ...row, unopened: true };
        return {
            ...row,
            body: content.body,
            files: (content.files ?? []).map((file) => ({ name: file.name, contentType: file.type }))
        };
    });
}
