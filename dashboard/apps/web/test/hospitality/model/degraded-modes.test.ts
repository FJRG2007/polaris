/**
 * The degraded modes of docs/hospitality-parity.md ("Degraded modes"), one
 * block each: what keeps working, what the screen says, and that recovery is
 * automatic and changes nothing twice. A restart mid-request is in
 * offline-replay.test.ts; printing lives with the printers and is not here.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { degradedState } from "@polaris-app/hospitality/src/model/degraded";
import { enqueue, flush, memoryStore, type Delivery, type QueuedOp } from "@polaris-app/hospitality/src/model/offline-queue";

/** A server that stores by id and by status, the way the database does. */
function venueServer() {
    const stored = new Map<string, unknown>();
    const lineStatus = new Map<string, string>();
    let up = true;
    return {
        stored,
        lineStatus,
        set: (value: boolean) => (up = value),
        send: async (op: QueuedOp): Promise<Delivery> => {
            if (!up) throw new Error("fetch failed");
            if (op.kind === "mark") {
                const { lineIds, ready } = op.payload as { lineIds: string[]; ready: boolean };
                for (const id of lineIds) if (lineStatus.get(id) === (ready ? "sent" : "ready")) lineStatus.set(id, ready ? "ready" : "sent");
            } else if (!stored.has((op.payload as { id: string }).id)) {
                stored.set((op.payload as { id: string }).id, op.payload);
            }
            return { status: "ok" };
        }
    };
}

const op = (id: string, kind: string, payload: unknown, at: number): QueuedOp => ({ id, kind, payload, queuedAt: at });

describe("hospitality degraded modes", () => {
    it("says plainly what is degraded and how much waits", () => {
        expect(degradedState({ online: true, reachable: true, waiting: 0 })).toBe("live");
        expect(degradedState({ online: true, reachable: true, waiting: 3 })).toBe("syncing");
        expect(degradedState({ online: true, reachable: false, waiting: 3 })).toBe("offline");
        expect(degradedState({ online: false, reachable: true, waiting: 0 })).toBe("offline");
    });

    it("server down for minutes: the till keeps taking cash and the kitchen keeps marking, all sent once and in order", async () => {
        const server = venueServer();
        server.lineStatus.set("l1", "sent");
        const till = memoryStore();
        const kitchen = memoryStore();
        server.set(false);
        await enqueue(till, op("pay:p1", "pay", { id: "p1", amount: 1200, method: "cash" }, 1));
        await enqueue(till, op("cash:c1", "cash", { id: "c1", kind: "out", amount: 500 }, 2));
        await enqueue(kitchen, op("mark:1", "mark", { lineIds: ["l1"], ready: true }, 3));
        // Retries every 15 s while it is down: nothing leaves, nothing is lost.
        for (let i = 0; i < 20; i++) {
            expect((await flush(till, server.send)).left).toBe(2);
            expect((await flush(kitchen, server.send)).left).toBe(1);
        }
        expect(degradedState({ online: true, reachable: false, waiting: 3 })).toBe("offline");
        server.set(true);
        expect(await flush(till, server.send)).toMatchObject({ sent: 2, left: 0 });
        expect(await flush(kitchen, server.send)).toMatchObject({ sent: 1, left: 0 });
        expect([...server.stored.keys()]).toEqual(["p1", "c1"]);
        expect(server.lineStatus.get("l1")).toBe("ready");
        // A replay of the same work, from a copy of the queue, changes nothing.
        await enqueue(till, op("pay:p1", "pay", { id: "p1", amount: 1200, method: "cash" }, 1));
        await enqueue(kitchen, op("mark:1", "mark", { lineIds: ["l1"], ready: true }, 3));
        await flush(till, server.send);
        await flush(kitchen, server.send);
        expect(server.stored.size).toBe(2);
        expect(server.lineStatus.get("l1")).toBe("ready");
    });

    it("one device dead: the others keep working, and its queue lands once when it comes back", async () => {
        const server = venueServer();
        const dead = memoryStore();
        const alive = memoryStore();
        await enqueue(dead, op("add:a", "add", { id: "a" }, 1));
        // The dead device never flushes; the live one is not held up by it.
        await enqueue(alive, op("add:b", "add", { id: "b" }, 2));
        expect(await flush(alive, server.send)).toMatchObject({ sent: 1, left: 0 });
        expect([...server.stored.keys()]).toEqual(["b"]);
        // Back on: its queue survived in storage and goes out.
        expect(await flush(dead, server.send)).toMatchObject({ sent: 1, left: 0 });
        expect([...server.stored.keys()]).toEqual(["b", "a"]);
    });

    it("internet down: nothing in Hospitality reaches beyond this Polaris", () => {
        const root = join(__dirname, "../../../../hospitality/src");
        const files: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (statSync(path).isDirectory()) walk(path);
                else if (/\.(ts|tsx)$/.test(name)) files.push(path);
            }
        };
        walk(root);
        expect(files.length).toBeGreaterThan(10);
        const outside = files.filter((file) => /fetch\(\s*["'`]https?:|new EventSource\(\s*["'`]https?:|new WebSocket\(\s*["'`]wss?:/.test(readFileSync(file, "utf8")));
        expect(outside).toEqual([]);
    });
});
