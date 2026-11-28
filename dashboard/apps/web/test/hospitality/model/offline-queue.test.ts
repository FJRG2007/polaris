/**
 * The handheld's queue: orders taken with no network go out in order when it
 * is back, and a request that arrived before the answer was lost changes
 * nothing when it is replayed.
 */

import { describe, expect, it } from "vitest";
import {
    deliveryOf,
    enqueue,
    flush,
    memoryStore,
    RETRY_WINDOW_MS,
    type ActionAnswer,
    type Delivery,
    type QueuedOp
} from "@polaris-app/hospitality/src/model/offline-queue";

const op = (id: string, kind: string, at: number, payload: unknown = {}): QueuedOp => ({ id, kind, payload, queuedAt: at });

/** A server that stores each line id once, like `addLines` does. */
function fakeServer() {
    const lines = new Set<string>();
    let online = true;
    let dropAnswer = false;
    return {
        lines,
        setOnline: (value: boolean) => (online = value),
        dropNextAnswer: () => (dropAnswer = true),
        send: async (o: QueuedOp): Promise<Delivery> => {
            if (!online) throw new TypeError("Failed to fetch");
            if (o.kind === "refuse") return { status: "refused", error: "sold out" };
            for (const id of (o.payload as { lineIds?: string[] }).lineIds ?? []) lines.add(id);
            if (dropAnswer) {
                dropAnswer = false;
                throw new TypeError("network changed");
            }
            return { status: "ok" };
        }
    };
}

describe("the offline queue", () => {
    it("keeps everything while offline and sends it in order once back", async () => {
        const store = memoryStore();
        const server = fakeServer();
        server.setOnline(false);
        await enqueue(store, op("b", "add", 2, { lineIds: ["l2"] }));
        await enqueue(store, op("a", "add", 1, { lineIds: ["l1"] }));
        expect(await flush(store, server.send)).toEqual({ sent: 0, refused: [], left: 2 });
        server.setOnline(true);
        const order: string[] = [];
        const result = await flush(store, async (o) => (order.push(o.id), server.send(o)));
        expect(result).toEqual({ sent: 2, refused: [], left: 0 });
        expect(order).toEqual(["a", "b"]);
        expect(await store.all()).toEqual([]);
    });

    it("replays a request whose answer was lost without adding anything twice", async () => {
        const store = memoryStore();
        const server = fakeServer();
        await enqueue(store, op("a", "add", 1, { lineIds: ["l1", "l2"] }));
        server.dropNextAnswer();
        expect((await flush(store, server.send)).left).toBe(1);
        expect(server.lines.size).toBe(2);
        expect((await flush(store, server.send)).sent).toBe(1);
        expect(server.lines.size).toBe(2);
    });

    it("hands back a refused operation instead of retrying it forever", async () => {
        const store = memoryStore();
        const server = fakeServer();
        await enqueue(store, op("a", "refuse", 1));
        await enqueue(store, op("b", "add", 2, { lineIds: ["l1"] }));
        const result = await flush(store, server.send);
        expect(result.refused.map((r) => [r.op.id, r.error])).toEqual([["a", "sold out"]]);
        expect(result.sent).toBe(1);
        expect(await store.all()).toEqual([]);
    });

    it("keeps one copy of an operation queued twice", async () => {
        const store = memoryStore();
        await enqueue(store, op("a", "add", 1));
        await enqueue(store, op("a", "add", 5));
        expect(await store.all()).toHaveLength(1);
    });

    it("keeps an order the server failed on while the dashboard restarts, and sends it once", async () => {
        // The dashboard restarting under an update: the new container answers
        // before its database does, so the action fails on the server's side.
        const store = memoryStore();
        const lines = new Set<string>();
        let restarting = true;
        let now = 1_000;
        const action = async (o: QueuedOp): Promise<ActionAnswer> => {
            if (restarting) return { ok: false, error: "Something went wrong", retry: true };
            for (const id of (o.payload as { lineIds: string[] }).lineIds) lines.add(id);
            return { ok: true };
        };
        const send = async (o: QueuedOp) => deliveryOf(await action(o), o, now);
        await enqueue(store, op("a", "add", now, { lineIds: ["l1"] }));
        await enqueue(store, op("b", "send", now + 1, { lineIds: [] }));
        now += 30_000;
        expect(await flush(store, send)).toEqual({ sent: 0, refused: [], left: 2 });
        restarting = false;
        now += 30_000;
        expect(await flush(store, send)).toEqual({ sent: 2, refused: [], left: 0 });
        // A second flush, as the next tick would run, sends nothing again.
        expect(await flush(store, send)).toEqual({ sent: 0, refused: [], left: 0 });
        expect([...lines]).toEqual(["l1"]);
    });

    it("tells the waiter a refusal at once, and a server failure only once the retry window is over", () => {
        const queued = { queuedAt: 0 };
        expect(deliveryOf({ ok: true }, queued, 5)).toEqual({ status: "ok" });
        expect(deliveryOf({ ok: false, error: "sold out" }, queued, 5)).toEqual({ status: "refused", error: "sold out" });
        expect(deliveryOf({ ok: false, error: "x", retry: true }, queued, RETRY_WINDOW_MS - 1)).toEqual({ status: "offline" });
        expect(deliveryOf({ ok: false, error: "x", retry: true }, queued, RETRY_WINDOW_MS)).toEqual({ status: "refused", error: "x" });
    });
});
