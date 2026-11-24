"use client";

/**
 * A queue of offline writes kept in an account's local store and sent when the
 * connection comes back - the device half of `lib/offline/outbox`.
 *
 * Per account, because it lives in the account's own local store, which is
 * deleted on sign-out. Several tabs drain it one at a time under a Web Lock
 * where the browser has them; where they do not, the server's idempotency key is
 * what keeps two tabs from writing the same thing twice.
 */

import { useEffect } from "react";
import type { LocalStore } from "@/lib/chat/offline/local-store";
import { reachability, subscribeReachability } from "@/lib/reachability";
import { drainQueue, type QueuedEntry, type QueueEvent, type QueueSendResult } from "./outbox";

export interface WriteQueue<E extends QueuedEntry> {
    readAll(): Promise<E[]>;
    /** Keep a write to send. False when this device cannot keep it (no local
     *  store, a full disk): the caller sends it at once instead, with the same key. */
    enqueue(entry: Omit<E, "state" | "attempts" | "createdAt">): Promise<boolean>;
    /** Put an entry back in line, optionally with changed fields. */
    retry(entry: E, change?: Partial<E>): Promise<void>;
    discard(key: string): Promise<void>;
    /** Send whatever is waiting, oldest first. Calls during a run ask for one more. */
    flush(): void;
    /** Every sent or failed entry; null when the queue changed some other way. */
    subscribe(listener: (event: QueueEvent<E> | null) => void): () => void;
}

export function createWriteQueue<E extends QueuedEntry>(options: {
    store: LocalStore;
    /** The local store kind the entries live under. */
    kind: string;
    /** The Web Lock name, made per account. */
    lock: string;
    deliver(entry: E): Promise<QueueSendResult>;
}): WriteQueue<E> {
    const { store, kind } = options;
    const listeners = new Set<(event: QueueEvent<E> | null) => void>();
    const notify = (event: QueueEvent<E> | null): void => {
        for (const listener of listeners) listener(event);
    };
    let running: Promise<void> | null = null;
    let again = false;

    const readAll = async (): Promise<E[]> => (await store.readAll<E>(kind)).map((entry) => entry.value);
    const drainOnce = async (): Promise<void> => {
        const entries = await readAll();
        if (entries.length === 0) return;
        await drainQueue(entries, {
            send: options.deliver,
            save: async (entry) => void (await store.write(kind, entry.key, entry)),
            drop: (key) => store.forget(kind, key),
            notify
        });
    };

    const flush = (): void => {
        if (typeof navigator !== "undefined" && navigator.onLine === false) return;
        if (running) {
            again = true;
            return;
        }
        const owner = store.owner();
        if (!owner) return;
        const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
        const run = (): Promise<void> => drainOnce().catch(() => undefined);
        running = (locks ? locks.request(`${options.lock}:${owner}`, run) : run()).finally(() => {
            running = null;
            if (again) {
                again = false;
                flush();
            }
        });
    };

    return {
        readAll,
        enqueue(entry) {
            const full = { ...entry, state: "pending", attempts: 0, createdAt: new Date().toISOString() } as E;
            return store.write(kind, full.key, full);
        },
        async retry(entry, change) {
            await store.write(kind, entry.key, { ...entry, ...change, state: "pending", attempts: 0, reason: undefined });
            notify(null);
            flush();
        },
        async discard(key) {
            await store.forget(kind, key);
            notify(null);
        },
        flush,
        subscribe(listener) {
            listeners.add(listener);
            return () => void listeners.delete(listener);
        }
    };
}

/** Flush on mount, when the network returns, when Polaris answers again after a
 *  stretch of not answering (the network can be up with the host down), and when
 *  the app comes back to the foreground. */
export function useQueueFlusher(flush: () => void, deps: readonly unknown[]): void {
    useEffect(() => {
        const visible = (): void => {
            if (document.visibilityState === "visible") flush();
        };
        let recoveries = reachability().recoveries;
        const recovered = (): void => {
            const now = reachability();
            if (now.reachable && now.recoveries !== recoveries) flush();
            recoveries = now.recoveries;
        };
        const unsubscribe = subscribeReachability(recovered);
        flush();
        window.addEventListener("online", flush);
        document.addEventListener("visibilitychange", visible);
        return () => {
            unsubscribe();
            window.removeEventListener("online", flush);
            document.removeEventListener("visibilitychange", visible);
        };
    }, deps);
}
