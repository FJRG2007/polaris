/**
 * A Polaris update or restart in the middle of service: the server goes away
 * (before a request, or after applying it but before answering), pages reload
 * with work still queued, and two devices - or two tabs sharing one device's
 * queue - replay at the same time. Whatever the sequence, every line and every
 * payment lands exactly once, and each device's work lands in the order it was
 * taken.
 *
 * The fake server stores by id the way the database does (primary keys made on
 * the device, `createMany(..., skipDuplicates)`), which is what makes a replay
 * a no-op; that part of the real server is not exercised here.
 */

import { describe, expect, it } from "vitest";
import { enqueue, flush, memoryStore, type Delivery, type QueuedOp, type QueueStore } from "@polaris-app/hospitality/src/model/offline-queue";

/** mulberry32: small, fast, deterministic. */
function seeded(seed: number) {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

type Mode = "up" | "down" | "applyThenDrop";

function fakeServer() {
    const stored = new Map<string, { device: string; queuedAt: number; amount: number }>();
    const applied: Array<{ device: string; queuedAt: number }> = [];
    let mode: Mode = "up";
    return {
        stored,
        applied,
        set: (next: Mode) => (mode = next),
        send: async (device: string, op: QueuedOp): Promise<Delivery> => {
            // Let other flushes interleave, as real requests do.
            await Promise.resolve();
            if (mode === "down") throw new Error("fetch failed");
            const p = op.payload as { amount: number };
            if (!stored.has(op.id)) {
                stored.set(op.id, { device, queuedAt: op.queuedAt, amount: p.amount });
                applied.push({ device, queuedAt: op.queuedAt });
            }
            // The server restarted after committing, before the answer left.
            if (mode === "applyThenDrop") throw new Error("socket hang up");
            return { status: "ok" };
        }
    };
}

describe("hospitality offline replay across a restart", () => {
    it("replaying after a restart changes nothing", async () => {
        const server = fakeServer();
        const store = memoryStore();
        await enqueue(store, { id: "pay-1", kind: "pay", payload: { amount: 1250 }, queuedAt: 1 });
        server.set("applyThenDrop");
        expect((await flush(store, (op) => server.send("a", op))).left).toBe(1);
        server.set("up");
        expect((await flush(store, (op) => server.send("a", op))).left).toBe(0);
        expect((await flush(store, (op) => server.send("a", op))).left).toBe(0);
        expect([...server.stored.keys()]).toEqual(["pay-1"]);
    });

    it("a reload with an order queued loses nothing", async () => {
        const server = fakeServer();
        // The queue outlives the page: a reloaded page opens the same store.
        const persisted = memoryStore();
        await enqueue(persisted, { id: "open-1", kind: "open", payload: { amount: 0 }, queuedAt: 1 });
        await enqueue(persisted, { id: "add-1", kind: "add", payload: { amount: 300 }, queuedAt: 2 });
        server.set("down");
        await flush(persisted, (op) => server.send("a", op));
        // ...the auto-update reloads the page here; nothing in memory survives but the store.
        server.set("up");
        const reloaded: QueueStore = persisted;
        expect((await reloaded.all()).map((o) => o.id)).toEqual(["open-1", "add-1"]);
        await flush(reloaded, (op) => server.send("a", op));
        expect([...server.stored.keys()]).toEqual(["open-1", "add-1"]);
        expect(await reloaded.all()).toEqual([]);
    });

    it("two devices and two tabs replaying at once double nothing (fuzzed)", async () => {
        for (let seed = 1; seed <= 300; seed++) {
            const rnd = seeded(seed);
            const server = fakeServer();
            const devices = ["a", "b"].map((name) => ({ name, store: memoryStore(), taken: new Map<string, number>() }));
            let clock = 0;
            for (let step = 0; step < 40; step++) {
                const roll = rnd();
                const device = devices[Math.floor(rnd() * devices.length)]!;
                if (roll < 0.45) {
                    const id = `${device.name}-${step}`;
                    const amount = 1 + Math.floor(rnd() * 5000);
                    device.taken.set(id, amount);
                    await enqueue(device.store, { id, kind: rnd() < 0.5 ? "add" : "pay", payload: { amount }, queuedAt: ++clock });
                    // A double tap enqueues the same id again.
                    if (rnd() < 0.2) await enqueue(device.store, { id, kind: "pay", payload: { amount }, queuedAt: ++clock });
                } else if (roll < 0.65) {
                    server.set(rnd() < 0.5 ? "down" : "applyThenDrop");
                } else if (roll < 0.8) {
                    server.set("up");
                } else {
                    // Both tabs of this device and the other device flush at the same moment.
                    await Promise.all([
                        flush(device.store, (op) => server.send(device.name, op)),
                        flush(device.store, (op) => server.send(device.name, op)),
                        ...devices.filter((d) => d !== device).map((d) => flush(d.store, (op) => server.send(d.name, op)))
                    ]);
                }
            }
            server.set("up");
            for (const d of devices) {
                await flush(d.store, (op) => server.send(d.name, op));
                expect(await d.store.all(), `seed ${seed}`).toEqual([]);
            }
            const expected = new Map(devices.flatMap((d) => [...d.taken]));
            expect(server.stored.size, `seed ${seed}`).toBe(expected.size);
            for (const [id, amount] of expected) expect(server.stored.get(id)?.amount, `seed ${seed} ${id}`).toBe(amount);
            const totalExpected = [...expected.values()].reduce((s, x) => s + x, 0);
            const totalStored = [...server.stored.values()].reduce((s, x) => s + x.amount, 0);
            expect(totalStored, `seed ${seed}`).toBe(totalExpected);
            // Each device's work landed in the order it was taken.
            for (const d of devices) {
                const order = server.applied.filter((x) => x.device === d.name).map((x) => x.queuedAt);
                expect(order, `seed ${seed} ${d.name}`).toEqual([...order].sort((x, y) => x - y));
            }
        }
    });
});
