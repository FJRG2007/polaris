import { describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/live/pg-listener", () => ({ NOTIFY_PAYLOAD_LIMIT: 8000, pgListener: () => ({ listen: vi.fn() }) }));
vi.mock("@/lib/computers/computer-commands", () => ({ relayNode: () => "node-a" }));

const { createRunnerBus, cutNotice } = await import("@/lib/computers/computer-bus");

const RUNNER = "0190a5f2-3333-7000-8000-0000000000bb";
const SESSION = "4a1f7a52-8a9c-4f0e-9b7d-2c5e6f1a3b4c";

function pair() {
    const wire: string[] = [];
    const received: unknown[] = [];
    const sender = createRunnerBus({ node: () => "node-a", notify: async (payload) => void wire.push(payload), receive: () => undefined });
    const receiver = createRunnerBus({ node: () => "node-b", notify: async () => undefined, receive: (notice) => void received.push(notice) });
    return { wire, received, sender, receiver };
}

describe("runner bus", () => {
    it("carries a chat event too large for one NOTIFY in pieces and puts it back together", async () => {
        const { wire, received, sender, receiver } = pair();
        const notice = { k: "chat" as const, runnerId: RUNNER, frame: { turnId: "t1", seq: 3, event: { kind: "text" as const, text: "x".repeat(30_000) } } };
        await sender.publish(notice);
        expect(wire.length).toBeGreaterThan(1);
        for (const payload of wire) expect(payload.length).toBeLessThan(8000);
        for (const payload of wire) receiver.accept(payload);
        expect(received).toEqual([notice]);
    });

    it("hands progress to other nodes and skips its own notices", async () => {
        const { wire, received, sender, receiver } = pair();
        const notice = { k: "progress" as const, sessionId: SESSION, progress: { tool: "git", step: "download" as const, received: 1, total: 4 } };
        await sender.publish(notice);
        sender.accept(wire[0]!);
        receiver.accept(wire[0]!);
        expect(received).toEqual([notice]);
    });

    it("drops a malformed or invalid notice", () => {
        const { received, receiver } = pair();
        receiver.accept("not json");
        for (const payload of cutNotice("node-a", "0190a5f2-3333-7000-8000-0000000000ee", JSON.stringify({ k: "chat", runnerId: "nope" }))) receiver.accept(payload);
        expect(received).toEqual([]);
    });
});
