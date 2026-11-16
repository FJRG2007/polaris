import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: unknown[] = [];
vi.mock("@/lib/computers/computer-commands", () => ({
    sendToRunner: vi.fn(async (_runnerId: string, command: unknown) => {
        sent.push(command);
        return true;
    })
}));
const findMany = vi.fn();
vi.mock("@polaris/db", () => ({ prisma: { agentRunner: { findMany: (...args: unknown[]) => findMany(...args) } } }));
vi.mock("@/lib/computers/computer-bus", () => ({ onRunnerLive: vi.fn(), publishRunnerLive: vi.fn(async () => undefined) }));

const { deliverChatEvent, runSubscriptionTurn, subscriptionRunnerFor } = await import("@/lib/polar/claude-subscription/turns");

const TURN = "0190a5f2-1111-7000-8000-0000000000aa";
const RUNNER = "0190a5f2-1111-7000-8000-0000000000bb";
const OTHER = "0190a5f2-1111-7000-8000-0000000000cc";

beforeEach(() => {
    sent.length = 0;
    findMany.mockReset();
});

describe("runSubscriptionTurn", () => {
    it("sends the turn, yields events in sequence order, and ignores another runner's frames", async () => {
        const turn = runSubscriptionTurn({ userId: "u1", runnerId: RUNNER, turnId: TURN, model: null, system: "s", messages: [{ role: "user", text: "hi" }], effort: null, mcp: null });
        const first = turn.next();
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        expect(sent[0]).toMatchObject({ type: "chat.turn", turnId: TURN });

        expect(deliverChatEvent(OTHER, { turnId: TURN, seq: 0, event: { kind: "text", text: "spoof" } })).toBe(false);
        expect(deliverChatEvent(RUNNER, { turnId: TURN, seq: 1, event: { kind: "finish", reason: "stop" } })).toBe(true);
        expect(deliverChatEvent(RUNNER, { turnId: TURN, seq: 0, event: { kind: "text", text: "Hello" } })).toBe(true);
        expect(deliverChatEvent(RUNNER, { turnId: TURN, seq: 0, event: { kind: "text", text: "replay" } })).toBe(false);

        expect((await first).value).toEqual({ kind: "text", text: "Hello" });
        expect((await turn.next()).value).toEqual({ kind: "finish", reason: "stop" });
        expect((await turn.next()).done).toBe(true);
        expect(deliverChatEvent(RUNNER, { turnId: TURN, seq: 2, event: { kind: "text", text: "late" } })).toBe(false);
    });

    it("cancels on the runner when the person stops the turn", async () => {
        const controller = new AbortController();
        const turn = runSubscriptionTurn({ userId: "u1", runnerId: RUNNER, turnId: TURN, model: null, system: "s", messages: [{ role: "user", text: "hi" }], effort: null, mcp: null, signal: controller.signal });
        const pending = turn.next();
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        controller.abort();
        expect((await pending).done).toBe(true);
        expect(sent[1]).toEqual({ type: "chat.cancel", turnId: TURN });
    });
});

describe("subscriptionRunnerFor", () => {
    it("offers only an online computer that announced claude-chat", async () => {
        const now = Date.now();
        findMany.mockResolvedValue([
            { id: OTHER, relayNode: "n1", lastSeenAt: new Date(now), capabilities: { features: ["toolchain"] } },
            { id: RUNNER, relayNode: "n1", lastSeenAt: new Date(now), capabilities: { features: ["claude-chat"] } }
        ]);
        expect(await subscriptionRunnerFor("u1", now)).toBe(RUNNER);
        findMany.mockResolvedValue([{ id: RUNNER, relayNode: "n1", lastSeenAt: new Date(now - 10 * 60_000), capabilities: { features: ["claude-chat"] } }]);
        expect(await subscriptionRunnerFor("u1", now)).toBeNull();
        findMany.mockResolvedValue([{ id: RUNNER, relayNode: "n1", lastSeenAt: new Date(now), capabilities: {} }]);
        expect(await subscriptionRunnerFor("u1", now)).toBeNull();
    });
});
