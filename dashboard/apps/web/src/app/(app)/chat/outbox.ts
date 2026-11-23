"use client";

/**
 * The outbox on this device: messages kept until the server takes them, sent
 * when the connection comes back - see `lib/chat/offline/outbox`.
 *
 * Per account, because it lives in the account's own local store, which is
 * deleted on sign-out. Several tabs drain it one at a time under a Web Lock
 * where the browser has them; where it does not, the server's idempotency key
 * is what keeps two tabs from posting the same message twice.
 */

import { useEffect } from "react";
import * as actions from "./actions";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import { chatStore } from "@/lib/chat/offline/chat-cache";
import { drainOutbox, type OutboxEntry, type OutboxEvent, type OutboxSendResult } from "@/lib/chat/offline/outbox";

const KIND = "outbox";
const listeners = new Set<(event: OutboxEvent | null) => void>();

export function subscribeOutbox(listener: (event: OutboxEvent | null) => void): () => void {
    listeners.add(listener);
    return () => void listeners.delete(listener);
}

function notify(event: OutboxEvent | null): void {
    for (const listener of listeners) listener(event);
}

export async function readOutbox(channelId: string): Promise<OutboxEntry[]> {
    const all = await chatStore.readAll<OutboxEntry>(KIND);
    return all.map((entry) => entry.value).filter((entry) => entry.channelId === channelId);
}

/** Keep a message to send. False when this device cannot keep it (no local
 *  store, a full disk): the caller sends it at once instead, with the same key. */
export function enqueue(entry: Omit<OutboxEntry, "state" | "attempts" | "createdAt">): Promise<boolean> {
    const full: OutboxEntry = { ...entry, state: "pending", attempts: 0, createdAt: new Date().toISOString() };
    return chatStore.write(KIND, full.key, full);
}

export async function retry(entry: OutboxEntry): Promise<void> {
    await chatStore.write(KIND, entry.key, { ...entry, state: "pending", attempts: 0, reason: undefined });
    notify(null);
    flushOutbox();
}

export async function discard(key: string): Promise<void> {
    await chatStore.forget(KIND, key);
    notify(null);
}

/** A message on its way: an outbox entry, or a thread answer (`parentId`, no key of its own). */
type Sendable = Pick<OutboxEntry, "channelId" | "body" | "replyToId" | "translation"> & { key?: string; parentId?: string | null };

/**
 * Send one message now, for a caller that could not keep it in the outbox:
 * answers as `sendAction` does and throws when the server cannot be reached.
 * With sealed chat off it is `sendAction` itself.
 */
export async function sendNow(entry: Sendable): Promise<{ id?: string; error?: string }> {
    if (!sealedChat.sealedChatActive())
        return actions.sendAction({
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
        const result = await actions.sendAction({
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

let running: Promise<void> | null = null;
let again = false;

async function drainOnce(): Promise<void> {
    const entries = (await chatStore.readAll<OutboxEntry>(KIND)).map((entry) => entry.value);
    if (entries.length === 0) return;
    await drainOutbox(entries, {
        send: deliver,
        save: async (entry) => void (await chatStore.write(KIND, entry.key, entry)),
        drop: (key) => chatStore.forget(KIND, key),
        notify
    });
}

/** Send whatever is waiting, oldest first. Calls during a run ask for one more. */
export function flushOutbox(): void {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    if (running) {
        again = true;
        return;
    }
    const owner = chatStore.owner();
    if (!owner) return;
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    const run = (): Promise<void> => drainOnce().catch(() => undefined);
    running = (locks ? locks.request(`polaris-chat-outbox:${owner}`, run) : run()).finally(() => {
        running = null;
        if (again) {
            again = false;
            flushOutbox();
        }
    });
}

/** Mounted once with the chat: sends on open, when the network returns and
 *  when the app comes back to the foreground. */
export function useOutboxFlusher(viewerId: string): void {
    useEffect(() => {
        const flush = (): void => {
            if (document.visibilityState === "visible") flushOutbox();
        };
        flushOutbox();
        window.addEventListener("online", flush);
        document.addEventListener("visibilitychange", flush);
        return () => {
            window.removeEventListener("online", flush);
            document.removeEventListener("visibilitychange", flush);
        };
    }, [viewerId]);
}
