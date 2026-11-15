/**
 * Messages typed mid-turn wait and go one per finished turn, oldest first; a
 * message is sent once even when two deliveries race, and one that fails to
 * send goes back to the front instead of being lost.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/agents/session-runtime", () => ({}));
vi.mock("@/lib/agents/session-service", () => ({}));
vi.mock("@/lib/agents/session-attachments", () => ({}));

import {
    deliverNextQueued,
    shouldQueuePrompt,
    type QueuePorts
} from "@/lib/agents/session-prompt-queue";

type Row = { id: string; text: string; authorId: string; attachments: string[]; createdAt: Date };

function memoryPorts(rows: Row[], sendFails = false) {
    const sent: string[] = [];
    const ports: QueuePorts = {
        oldest: async () =>
            [...rows].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())[0] ?? null,
        claim: async (id) => {
            const index = rows.findIndex((row) => row.id === id);
            if (index < 0) return false;
            rows.splice(index, 1);
            return true;
        },
        putBack: async (_sessionId, row) => {
            rows.push({ id: `back-${row.text}`, ...row });
        },
        send: async (_sessionId, _authorId, text) => {
            if (sendFails) throw new Error("machine gone");
            sent.push(text);
        }
    };
    return { ports, sent, rows };
}

const at = (seconds: number) => new Date(Date.UTC(2026, 10, 15, 10, 0, seconds));

describe("shouldQueuePrompt", () => {
    it("queues while the agent is mid-turn", () => {
        expect(shouldQueuePrompt("working", 0)).toBe(true);
    });

    it("sends at once to an agent at its prompt with nothing waiting", () => {
        expect(shouldQueuePrompt("idle", 0)).toBe(false);
        expect(shouldQueuePrompt("waiting", 0)).toBe(false);
    });

    it("queues behind messages already waiting, so none jumps the line", () => {
        expect(shouldQueuePrompt("idle", 2)).toBe(true);
    });

    it("never queues on a session that has ended", () => {
        expect(shouldQueuePrompt("stopped", 3)).toBe(false);
    });
});

describe("deliverNextQueued", () => {
    it("sends the oldest message, one per call, in the order typed", async () => {
        const { ports, sent, rows } = memoryPorts([
            { id: "b", text: "second", authorId: "u1", attachments: [], createdAt: at(2) },
            { id: "a", text: "first", authorId: "u1", attachments: [], createdAt: at(1) }
        ]);
        expect(await deliverNextQueued("s1", ports)).toBe(true);
        expect(sent).toEqual(["first"]);
        expect(rows.map((row) => row.id)).toEqual(["b"]);
        expect(await deliverNextQueued("s1", ports)).toBe(true);
        expect(sent).toEqual(["first", "second"]);
        expect(await deliverNextQueued("s1", ports)).toBe(false);
    });

    it("sends nothing when another delivery claimed the message first", async () => {
        const { ports, sent } = memoryPorts([
            { id: "a", text: "first", authorId: "u1", attachments: [], createdAt: at(1) }
        ]);
        const lost: QueuePorts = { ...ports, claim: async () => false };
        expect(await deliverNextQueued("s1", lost)).toBe(false);
        expect(sent).toEqual([]);
    });

    it("puts a message that could not be sent back at the front", async () => {
        const { ports, rows } = memoryPorts(
            [
                { id: "a", text: "first", authorId: "u1", attachments: ["f1"], createdAt: at(1) },
                { id: "b", text: "second", authorId: "u1", attachments: [], createdAt: at(2) }
            ],
            true
        );
        const quiet = vi.spyOn(console, "error").mockImplementation(() => undefined);
        expect(await deliverNextQueued("s1", ports)).toBe(false);
        quiet.mockRestore();
        const next = await ports.oldest("s1");
        expect(next?.text).toBe("first");
        expect(next?.attachments).toEqual(["f1"]);
        expect(rows).toHaveLength(2);
    });
});
