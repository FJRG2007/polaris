/**
 * The chat's kind of offline write: a message kept on this device until the
 * server takes it. The ordering, retry and failure rules are the shared ones
 * (`lib/offline/outbox`); what is chat's own is the shape of an entry and the
 * conversation each event belongs to.
 */

import type * as core from "@polaris/core";
import { drainQueue, type QueuedEntry, type QueueSendResult } from "@/lib/offline/outbox";

export { OUTBOX_MAX_ATTEMPTS, newClientKey } from "@/lib/offline/outbox";

export interface OutboxEntry extends QueuedEntry {
    readonly channelId: string;
    readonly body: string;
    readonly replyToId: string | null;
    readonly translation?: core.ChatSentTranslation;
}

export type OutboxSendResult = QueueSendResult;

export type OutboxEvent =
    | { readonly key: string; readonly channelId: string; readonly sent: string }
    | { readonly key: string; readonly channelId: string; readonly failed: string };

export function outboxEvent(event: { entry: OutboxEntry; sent: string } | { entry: OutboxEntry; failed: string }): OutboxEvent {
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
