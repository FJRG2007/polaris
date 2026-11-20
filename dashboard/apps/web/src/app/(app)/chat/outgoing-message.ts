import type { Outgoing } from "./outgoing";
import { draftMessage } from "./draft-message";
import { isInlineImage, typeOfFile } from "@/lib/mime";
import type { ChatAttachmentView, ChatMessageView } from "@/lib/chat/messages";

/**
 * A message with files, drawn in the conversation while its files go.
 *
 * Drawn as a row of the list itself rather than as something of its own under
 * it, so it sits where the message will sit, through the same attachment
 * components the landed message uses, at the size the server will report for
 * it. When it lands, the real message takes this row's key - see `landedAs` -
 * and what was drawn stays drawn.
 */

const ROW = "outgoing:";

export function outgoingRowId(id: string): string {
    return `${ROW}${id}`;
}

/** Whether a row in the list is a message still on its way. */
export function isOutgoingRow(id: string): boolean {
    return id.startsWith(ROW);
}

/** The key one file of a message on its way is drawn under. */
export function outgoingFileId(rowId: string, index: number): string {
    return `${rowId}:${index}`;
}

/** Which file of its message an attachment on its way is, or null for a Drive
 *  pick and for anything that is not on its way. */
export function outgoingFileIndex(attachmentId: string): number | null {
    if (!isOutgoingRow(attachmentId)) return null;
    const index = Number(attachmentId.slice(attachmentId.lastIndexOf(":") + 1));
    return attachmentId.includes(":drive:") || !Number.isInteger(index) ? null : index;
}

export function outgoingMessage(
    one: Outgoing,
    facts: {
        readonly channelId: string;
        readonly authorId: string;
        readonly authorName: string;
        readonly parentId?: string | null;
    }
): ChatMessageView {
    const id = outgoingRowId(one.id);
    const draft = draftMessage({ id, ...facts, body: one.body });
    const files = one.files.flatMap((file, index): ChatAttachmentView[] => {
        // A file the sender stopped is out of the message.
        if (one.items?.[index]?.phase === "cancelled") return [];
        const contentType = typeOfFile(file.type, file.name);
        const once = one.viewOnce?.find((choice) => choice.index === index);
        const shape = one.shapes?.[index] ?? null;
        const sound = one.sounds?.[index];
        return [
            {
                id: outgoingFileId(id, index),
                name: file.name,
                size: file.size,
                contentType,
                inline: isInlineImage(contentType) && !once,
                durationMs: sound?.durationMs ?? null,
                waveform: sound?.waveform ?? null,
                hasPoster: false,
                width: shape?.width ?? null,
                height: shape?.height ?? null,
                thumbhash: shape?.thumbhash ?? null,
                spoiler: one.hidden.includes(index),
                borrowed: false,
                ...(once
                    ? {
                          viewOnce: {
                              seconds: once.seconds,
                              captured: once.captured ?? null,
                              opened: false,
                              openedCount: 0,
                              gone: false
                          }
                      }
                    : {})
            }
        ];
    });
    // Drive picks come after the files, and `hidden` counts them there too.
    const kept = one.kept.map(
        (pick, at): ChatAttachmentView => ({
            id: `${id}:drive:${at}`,
            name: pick.name,
            size: pick.size,
            contentType: typeOfFile(null, pick.name),
            // Its bytes are not in this browser, so there is no picture to draw yet.
            inline: false,
            durationMs: null,
            waveform: null,
            hasPoster: false,
            width: null,
            height: null,
            thumbhash: null,
            spoiler: one.hidden.includes(one.files.length + at),
            borrowed: true
        })
    );
    return {
        ...draft,
        parentId: facts.parentId ?? null,
        createdAt: one.at ?? draft.createdAt,
        attachments: [...files, ...kept]
    };
}

/** The messages on their way that are not on screen as themselves yet. */
export function unlandedOutgoing(
    outgoing: readonly Outgoing[],
    messages: readonly ChatMessageView[]
): readonly Outgoing[] {
    const shown = new Set(messages.map((message) => message.id));
    return outgoing.filter((one) => !one.posted || !shown.has(one.posted));
}

/** The conversation as drawn: what the server has, then what is still on its
 *  way, in the order it was sent. */
export function withSending(
    messages: readonly ChatMessageView[],
    sending: readonly ChatMessageView[]
): readonly ChatMessageView[] {
    if (sending.length === 0) return messages;
    return [...messages, ...[...sending].sort((left, right) => left.createdAt.localeCompare(right.createdAt))];
}
