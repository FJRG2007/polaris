/**
 * An outage does not use up a waiting write's attempts: an attempt that found
 * no server counts only while Polaris itself answers, so a write kept during
 * a long outage, flushed again and again, is still waiting when Polaris is back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalStore } from "@/lib/chat/offline/local-store";
import { drainQueue, OUTBOX_MAX_ATTEMPTS, type QueuedEntry } from "@/lib/offline/outbox";

const state = vi.hoisted(() => ({ reachable: true, answers: true, probes: 0 }));

vi.mock("@/lib/reachability", () => ({
    reachability: () => ({ reachable: state.reachable, recoveries: 0 }),
    subscribeReachability: () => () => undefined,
    probeNow: async () => {
        state.probes += 1;
        return state.answers;
    }
}));

const { createWriteQueue } = await import("@/lib/offline/write-queue");

const entry = (key: string, createdAt: string, attempts = 0): QueuedEntry => ({ key, createdAt, state: "pending", attempts });

function memoryStore(): LocalStore {
    const rows = new Map<string, unknown>();
    return {
        setOwner: () => undefined,
        owner: () => "u1",
        read: async <T>(kind: string, id: string) => (rows.get(`${kind}:${id}`) as T) ?? null,
        readAll: async <T>(kind: string) =>
            [...rows].filter(([key]) => key.startsWith(`${kind}:`)).map(([key, value]) => ({ id: key.slice(kind.length + 1), value: value as T })),
        write: async (kind, id, value) => {
            rows.set(`${kind}:${id}`, value);
            return true;
        },
        forget: async (kind, id) => void rows.delete(`${kind}:${id}`),
        clear: async () => rows.clear()
    };
}

/** Wait for a flush to finish: it runs in the background. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
    state.reachable = true;
    state.answers = true;
    state.probes = 0;
});

describe("the retry budget of a waiting write", () => {
    it("is not spent while Polaris does not answer", async () => {
        const saved: QueuedEntry[] = [];
        await drainQueue([entry("a", "1", OUTBOX_MAX_ATTEMPTS - 1)], {
            send: async () => "unreachable",
            save: async (one) => void saved.push(one),
            drop: async () => undefined,
            notify: () => undefined,
            counts: async () => false
        });
        expect(saved).toEqual([]);
    });

    it("is spent when Polaris answers and this write still does not get through", async () => {
        const saved: QueuedEntry[] = [];
        await drainQueue([entry("a", "1", OUTBOX_MAX_ATTEMPTS - 1)], {
            send: async () => "unreachable",
            save: async (one) => void saved.push(one),
            drop: async () => undefined,
            notify: () => undefined,
            counts: async () => true
        });
        expect(saved).toEqual([{ ...entry("a", "1", OUTBOX_MAX_ATTEMPTS), state: "failed" }]);
    });

    it("survives many flushes during one outage, and asks no more than the probe's own backoff", async () => {
        const store = memoryStore();
        const queue = createWriteQueue<QueuedEntry>({ store, kind: "k", lock: "l", deliver: async () => "unreachable" });
        await queue.enqueue({ key: "a" });
        state.reachable = false;
        for (let round = 0; round < OUTBOX_MAX_ATTEMPTS * 3; round++) {
            queue.flush();
            await settle();
        }
        expect(await queue.readAll()).toEqual([expect.objectContaining({ key: "a", state: "pending", attempts: 0 })]);
        expect(state.probes).toBe(0);
    });

    it("counts a failed attempt once a probe says Polaris answers", async () => {
        const store = memoryStore();
        const queue = createWriteQueue<QueuedEntry>({ store, kind: "k", lock: "l", deliver: async () => "unreachable" });
        await queue.enqueue({ key: "a" });
        for (let round = 0; round < OUTBOX_MAX_ATTEMPTS; round++) {
            queue.flush();
            await settle();
        }
        expect(await queue.readAll()).toEqual([expect.objectContaining({ key: "a", state: "failed" })]);
    });

    it("waits uncounted when the probe finds Polaris down", async () => {
        const store = memoryStore();
        const queue = createWriteQueue<QueuedEntry>({ store, kind: "k", lock: "l", deliver: async () => "unreachable" });
        await queue.enqueue({ key: "a" });
        state.answers = false;
        queue.flush();
        await settle();
        expect(await queue.readAll()).toEqual([expect.objectContaining({ state: "pending", attempts: 0 })]);
        expect(state.probes).toBe(1);
    });
});
