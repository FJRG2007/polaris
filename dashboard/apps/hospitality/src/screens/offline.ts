"use client";

/**
 * The browser side of the offline queue (`model/offline-queue`): the queue
 * lives in IndexedDB, so an order taken with no network survives a closed tab
 * or a handheld restarted, and goes out when the network is back - on the
 * `online` event, when the screen is shown again, and every 15 seconds while
 * anything waits.
 *
 * A server action that gets no answer rejects; one the server refused answers
 * `{ ok: false }`. That is the line between "keep it" and "tell the waiter".
 */

import { markLinesAction, moveCashAction, payAction } from "../actions/till";
import { reportReach, reportWaiting } from "./connection";
import { useCallback, useEffect, useRef, useState } from "react";
import { addLinesAction, openOrderAction, sendLinesAction } from "../actions/orders";
import { enqueue, flush, memoryStore, type Delivery, type QueuedOp, type QueueStore } from "../model/offline-queue";

const DB = "polaris-hospitality";
const STORE = "queue";

function request<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

let opened: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
    opened ??= new Promise((resolve, reject) => {
        const req = indexedDB.open(DB, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "id" });
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return opened;
}

function indexedStore(): QueueStore {
    const run = async <T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>) =>
        request(work((await database()).transaction(STORE, mode).objectStore(STORE)));
    return {
        all: () => run("readonly", (s) => s.getAll() as IDBRequest<QueuedOp[]>),
        put: async (op) => void (await run("readwrite", (s) => s.put(op))),
        remove: async (id) => void (await run("readwrite", (s) => s.delete(id)))
    };
}

let shared: QueueStore | null = null;

function store(): QueueStore {
    if (shared) return shared;
    try {
        shared = typeof indexedDB === "undefined" ? memoryStore() : indexedStore();
    } catch {
        shared = memoryStore();
    }
    return shared;
}

const ACTIONS: Record<string, (payload: unknown) => Promise<{ ok: boolean; error?: string }>> = {
    open: (p) => openOrderAction(p) as Promise<{ ok: boolean; error?: string }>,
    add: (p) => addLinesAction(p) as Promise<{ ok: boolean; error?: string }>,
    send: (p) => sendLinesAction(p) as Promise<{ ok: boolean; error?: string }>,
    pay: (p) => payAction(p) as Promise<{ ok: boolean; error?: string }>,
    // The kitchen marking a ticket ready, and a till's cash in or out: both
    // stored once (a status change, an id the till made), so a replay is a no-op.
    mark: (p) => markLinesAction(p) as Promise<{ ok: boolean; error?: string }>,
    cash: (p) => moveCashAction(p) as Promise<{ ok: boolean; error?: string }>
};

async function deliver(op: QueuedOp): Promise<Delivery> {
    const action = ACTIONS[op.kind];
    if (!action) return { status: "refused", error: "" };
    let answer: { ok: boolean; error?: string };
    try {
        answer = await action(op.payload);
    } catch (caught) {
        reportReach(false);
        throw caught;
    }
    reportReach(true);
    return answer.ok ? { status: "ok" } : { status: "refused", error: answer.error ?? "" };
}

export interface OfflineQueue {
    /** Operations waiting for the network on this device. */
    readonly waiting: number;
    /** Queues the operations and sends what it can now. */
    submit(ops: ReadonlyArray<Omit<QueuedOp, "queuedAt">>): Promise<{ left: number; refused: string[] }>;
}

export function useOfflineQueue(onDelivered: () => void, onRefused: (error: string) => void): OfflineQueue {
    const [waiting, setWaiting] = useState(0);
    const callbacks = useRef({ onDelivered, onRefused });
    callbacks.current = { onDelivered, onRefused };
    const busy = useRef<Promise<{ left: number; refused: string[] }> | null>(null);

    const drain = useCallback(async () => {
        // One flush at a time: a second would send the same op twice at once.
        if (busy.current) return busy.current;
        busy.current = (async () => {
            const result = await flush(store(), deliver);
            setWaiting(result.left);
            reportWaiting(result.left);
            if (result.sent) callbacks.current.onDelivered();
            for (const r of result.refused) callbacks.current.onRefused(r.error);
            return { left: result.left, refused: result.refused.map((r) => r.error) };
        })().finally(() => (busy.current = null));
        return busy.current;
    }, []);

    useEffect(() => {
        void drain().catch(() => undefined);
        const retry = () => void drain().catch(() => undefined);
        window.addEventListener("online", retry);
        document.addEventListener("visibilitychange", retry);
        const timer = setInterval(() => waiting > 0 && retry(), 15_000);
        return () => {
            window.removeEventListener("online", retry);
            document.removeEventListener("visibilitychange", retry);
            clearInterval(timer);
        };
    }, [drain, waiting]);

    return {
        waiting,
        submit: async (ops) => {
            let at = Date.now();
            for (const op of ops) await enqueue(store(), { ...op, queuedAt: at++ });
            return drain();
        }
    };
}
