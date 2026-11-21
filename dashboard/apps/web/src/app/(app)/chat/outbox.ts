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
import { chatStore } from "@/lib/chat/offline/chat-cache";
import { drainOutbox, type OutboxEntry, type OutboxEvent } from "@/lib/chat/offline/outbox";

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

let running: Promise<void> | null = null;
let again = false;

async function drainOnce(): Promise<void> {
    const entries = (await chatStore.readAll<OutboxEntry>(KIND)).map((entry) => entry.value);
    if (entries.length === 0) return;
    await drainOutbox(entries, {
        async send(entry) {
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
        },
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
