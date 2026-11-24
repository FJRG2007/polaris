/**
 * The chat's kind of offline write: a message kept on this device until the
 * server takes it. The ordering, retry and failure rules are the shared ones
 * (`lib/offline/outbox`); what is chat's own is the shape of an entry and the
 * conversation each event belongs to.
 */

import type * as core from "@polaris/core";
import type { ChatMessageView } from "@/lib/chat/messages";
import { drainQueue, type QueuedEntry, type QueueSendResult } from "@/lib/offline/outbox";

export { OUTBOX_MAX_ATTEMPTS, newClientKey } from "@/lib/offline/outbox";

export interface OutboxEntry extends QueuedEntry {
    readonly channelId: string;
    readonly body: string;
    readonly replyToId: string | null;
    readonly translation?: core.ChatSentTranslation;
    /** Written while sealed chat was on: sent only by a page that has it open. */
    readonly sealed?: boolean;
}

/**
 * A change to a message already on the server, kept the same way: an edit, a
 * reaction pressed or taken back, a delete. Kept in the same line as the
 * messages, so a change made after a message waits behind it.
 */
export type ChatChange = QueuedEntry & {
    readonly channelId: string;
    readonly messageId: string;
} & (
        | {
              readonly op: "edit";
              readonly body: string;
              /** A sealed message: sealed again on this device when it is sent, never in the clear. */
              readonly sealed?: boolean;
              /** The version being replaced (a sealed row's `sealedEditedAt`). */
              readonly editedAt?: string;
          }
        | { readonly op: "react"; readonly emoji: string; /** Pressed (true) or taken back. */ readonly on: boolean }
        | { readonly op: "delete" }
    );

/** Anything in the chat's line: a message (no `op`) or a change. */
export type ChatQueued = OutboxEntry | ChatChange;

export function isChatChange(entry: ChatQueued): entry is ChatChange {
    return "op" in entry && typeof (entry as { op?: unknown }).op === "string";
}

/** The message with the reader's own reaction set to `mine`, counted. */
export function withReaction(message: ChatMessageView, emoji: string, mine: boolean): ChatMessageView {
    const existing = message.reactions.find((entry) => entry.emoji === emoji);
    if ((existing?.mine ?? false) === mine) return message;
    if (!existing) return { ...message, reactions: [...message.reactions, { emoji, count: 1, mine }] };
    const count = existing.count + (mine ? 1 : -1);
    return {
        ...message,
        reactions: message.reactions
            .map((entry) => (entry.emoji === emoji ? { ...entry, count, mine } : entry))
            .filter((entry) => entry.count > 0)
    };
}

/** Everything a deleted message drops on screen. The server resolves the cards,
 *  previews and forwards from the text, and a tombstone has no text - so any of
 *  them left behind is this browser showing what the message said after it was
 *  taken back. */
export const DELETED_MESSAGE: Partial<ChatMessageView> = {
    body: "",
    deleted: true,
    reactions: [],
    attachments: [],
    references: [],
    invites: [],
    groupInvites: [],
    link: null,
    preview: null,
    previewPending: false,
    forwardable: false
};

/**
 * The messages as they read with the changes still waiting on this device
 * laid over them, oldest change first, each changed row marked
 * `changeWaiting` so it carries the clock. A failed change is not laid over:
 * the row shows what the server has, and the change waits in the not-sent bar.
 */
export function withChanges(
    messages: readonly ChatMessageView[],
    changes: readonly ChatChange[]
): readonly ChatMessageView[] {
    const waiting = changes.filter((change) => change.state === "pending");
    if (!waiting.length) return messages;
    const byMessage = new Map<string, ChatChange[]>();
    for (const change of [...waiting].sort((a, b) => a.createdAt.localeCompare(b.createdAt))) {
        const list = byMessage.get(change.messageId) ?? [];
        list.push(change);
        byMessage.set(change.messageId, list);
    }
    let changed = false;
    const out = messages.map((message) => {
        const list = byMessage.get(message.id);
        if (!list || message.deleted) return message;
        let next: ChatMessageView = message;
        for (const change of list) {
            if (change.op === "edit") next = { ...next, body: change.body, edited: true };
            else if (change.op === "react") next = withReaction(next, change.emoji, change.on);
            else next = { ...next, ...DELETED_MESSAGE };
        }
        changed = true;
        return { ...next, changeWaiting: true };
    });
    return changed ? out : messages;
}

export type OutboxSendResult = QueueSendResult;

export type OutboxEvent =
    | { readonly key: string; readonly channelId: string; readonly sent: string }
    | { readonly key: string; readonly channelId: string; readonly failed: string };

export function outboxEvent(event: { entry: ChatQueued; sent: string } | { entry: ChatQueued; failed: string }): OutboxEvent {
    const { key, channelId } = event.entry;
    return "sent" in event ? { key, channelId, sent: event.sent } : { key, channelId, failed: event.failed };
}

export function drainOutbox(
    entries: readonly OutboxEntry[],
    io: {
        send(entry: OutboxEntry): Promise<OutboxSendResult>;
        save(entry: OutboxEntry): Promise<void>;
        drop(key: string): Promise<void>;
        notify(event: OutboxEvent): void;
    }
): Promise<void> {
    return drainQueue(entries, { ...io, notify: (event) => io.notify(outboxEvent(event)) });
}
