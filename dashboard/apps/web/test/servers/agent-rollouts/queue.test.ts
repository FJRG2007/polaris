/**
 * The offline queue's rules: commands go out oldest first, expired ones are
 * retired instead of delivered, a delivery cut off mid-way is retried a bounded
 * number of times, the queue per server is bounded, and only a waiting command
 * can be cancelled.
 */

import { describe, expect, it } from "vitest";
import * as queue from "@/lib/agent-rollouts/queue";

const now = new Date("2026-10-16T12:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60_000);
const later = (minutes: number) => new Date(now.getTime() + minutes * 60_000);

const row = (id: string, over: Partial<queue.QueuedRow> = {}): queue.QueuedRow => ({
    id,
    status: "queued",
    createdAt: ago(30),
    expiresAt: later(60),
    startedAt: null,
    attempts: 0,
    ...over
});

describe("drainOrder", () => {
    it("delivers oldest first, ties broken by id", () => {
        const { deliver } = queue.drainOrder(
            [
                row("c", { createdAt: ago(5) }),
                row("b", { createdAt: ago(10) }),
                row("a", { createdAt: ago(10) })
            ],
            now
        );
        expect(deliver.map((entry) => entry.id)).toEqual(["a", "b", "c"]);
    });

    it("expires what waited too long instead of delivering it", () => {
        const { deliver, expire } = queue.drainOrder(
            [row("old", { expiresAt: ago(1) }), row("fresh")],
            now
        );
        expect(expire.map((entry) => entry.id)).toEqual(["old"]);
        expect(deliver.map((entry) => entry.id)).toEqual(["fresh"]);
    });

    it("leaves a delivery in progress alone, and retries one that was cut off", () => {
        const { deliver, abandon } = queue.drainOrder(
            [
                row("busy", { status: "delivering", startedAt: ago(1), attempts: 1 }),
                row("cut", { status: "delivering", startedAt: ago(15), attempts: 1 }),
                row("spent", {
                    status: "delivering",
                    startedAt: ago(15),
                    attempts: queue.MAX_ATTEMPTS
                })
            ],
            now
        );
        expect(deliver.map((entry) => entry.id)).toEqual(["cut"]);
        expect(abandon.map((entry) => entry.id)).toEqual(["spent"]);
    });

    it("never touches finished or cancelled commands", () => {
        const result = queue.drainOrder(
            [row("done", { status: "done" }), row("gone", { status: "cancelled" })],
            now
        );
        expect(result).toEqual({ deliver: [], expire: [], abandon: [] });
    });
});

describe("limits and cancelling", () => {
    it("bounds the queue per server", () => {
        expect(queue.hasRoom(queue.QUEUE_LIMIT - 1)).toBe(true);
        expect(queue.hasRoom(queue.QUEUE_LIMIT)).toBe(false);
    });

    it("cancels only a command still waiting", () => {
        expect(queue.cancellable("queued")).toBe(true);
        expect(queue.cancellable("delivering")).toBe(false);
        expect(queue.cancellable("done")).toBe(false);
    });
});

describe("commands", () => {
    it("round-trips a payload and refuses one that no longer parses", () => {
        const spec = { kind: "container.restart" as const, container: "web-1" };
        expect(queue.readCommand(spec.kind, queue.payloadOf(spec))).toEqual(spec);
        expect(queue.readCommand("container.restart", '{"container":"; rm -rf /"}')).toBeNull();
        expect(queue.readCommand("container.restart", "not json")).toBeNull();
        expect(queue.readCommand("shell.run", "{}")).toBeNull();
    });

    it("requires a client-minted id so a retried submit is the same command", () => {
        expect(
            queue.enqueueSchema.safeParse({
                serverId: "local",
                command: { kind: "agent.update", version: "2.0.0" }
            }).success
        ).toBe(false);
        expect(
            queue.enqueueSchema.parse({
                id: "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a51",
                serverId: "local",
                command: { kind: "agent.update", version: "2.0.0" }
            }).expiry
        ).toBe("1d");
    });
});
