"use client";

/**
 * The outbox on this device: messages kept until the server takes them, sent
 * when the connection comes back. Chat's kind of the shared offline write queue
 * (`lib/offline/write-queue`), kept in the chat's own local store.
 */

import { sendAction } from "@/lib/poll-fetch";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import { chatStore } from "@/lib/chat/offline/chat-cache";
import { createWriteQueue, useQueueFlusher } from "@/lib/offline/write-queue";
import { outboxEvent, type OutboxEntry, type OutboxEvent, type OutboxSendResult } from "@/lib/chat/offline/outbox";

const queue = createWriteQueue<OutboxEntry>({
    store: chatStore,
    kind: "outbox",
    lock: "polaris-chat-outbox",
    deliver: (entry) => deliver(entry)
});

export function subscribeOutbox(listener: (event: OutboxEvent | null) => void): () => void {
    return queue.subscribe((event) => listener(event ? outboxEvent(event) : null));
}

export async function readOutbox(channelId: string): Promise<OutboxEntry[]> {
    return (await queue.readAll()).filter((entry) => entry.channelId === channelId);
}

/** Keep a message to send. False when this device cannot keep it (no local
 *  store, a full disk): the caller sends it at once instead, with the same key. */
export function enqueue(entry: Omit<OutboxEntry, "state" | "attempts" | "createdAt">): Promise<boolean> {
    return queue.enqueue(entry);
}

export function retry(entry: OutboxEntry): Promise<void> {
    return queue.retry(entry);
}

export function discard(key: string): Promise<void> {
    return queue.discard(key);
}

/** A message on its way: an outbox entry, or a thread answer (`parentId`, no key of its own). */
type Sendable = Pick<OutboxEntry, "channelId" | "body" | "replyToId" | "translation"> & { key?: string; parentId?: string | null };

/**
 * The ordinary send, through its route (`/api/chat/send`) rather than as a
 * server action: a tab's actions run one at a time behind its navigations, and
 * a message waited on its clock behind every typing ping and read mark the
 * screen had sent before it. Answers what `sendAction` answers.
 */
export function postMessage(input: {
    channelId: string;
    body: string;
    parentId?: string;
    replyToId?: string | null;
    translation?: OutboxEntry["translation"];
    clientKey?: string;
}): Promise<{ id?: string; error?: string }> {
    return sendAction<{ id?: string; error?: string }>("/api/chat/send", input);
}

/**
 * Send one message now, for a caller that could not keep it in the outbox:
 * answers as `sendAction` does and throws when the server cannot be reached.
 * With sealed chat off it is `sendAction` itself.
 */
export async function sendNow(entry: Sendable): Promise<{ id?: string; error?: string }> {
    if (!sealedChat.sealedChatActive())
        return postMessage({
            channelId: entry.channelId,
            body: entry.body,
            ...(entry.parentId ? { parentId: entry.parentId } : {}),
            replyToId: entry.replyToId,
            translation: entry.translation,
            ...(entry.key ? { clientKey: entry.key } : {})
        });
    const result = await deliver(entry);
    if (result === "unreachable") throw new Error("the sealed message could not be sent");
    return "sent" in result ? { id: result.sent } : { error: result.refused };
}

/**
 * Send one kept message: sealed through this browser's MLS device when sealed
 * chat is on (never in the clear instead), else the ordinary send.
 */
export async function deliver(entry: Sendable): Promise<OutboxSendResult> {
    if (sealedChat.sealedChatActive()) {
        try {
            const id = await sealedChat.sendSealedMessage({
                channelId: entry.channelId,
                body: entry.body,
                clientKey: entry.key ?? crypto.randomUUID(),
                parentId: entry.parentId ?? null,
                replyToId: entry.replyToId,
                ...(entry.translation ? { translation: entry.translation } : {})
            });
            return { sent: id };
        } catch (caught) {
            if (sealedChat.sealedSendFailure(caught) === "refused") return { refused: "" };
            console.warn("polaris: a sealed message was not sent yet:", caught);
            return "unreachable";
        }
    }
    try {
        const result = await postMessage({
            channelId: entry.channelId,
            body: entry.body,
            replyToId: entry.replyToId,
            translation: entry.translation,
            clientKey: entry.key
        });
        return result.id ? { sent: result.id } : { refused: result.error ?? "" };
    } catch {
        return "unreachable";
    }
}

/** Send whatever is waiting, oldest first. Calls during a run ask for one more. */
export function flushOutbox(): void {
    queue.flush();
}

/** Mounted once with the chat: sends on open, when the network returns and
 *  when the app comes back to the foreground. */
export function useOutboxFlusher(viewerId: string): void {
    useQueueFlusher(flushOutbox, [viewerId]);
}
