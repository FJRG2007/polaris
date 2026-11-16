import { beforeEach, describe, expect, it, vi } from "vitest";

const sent: unknown[] = [];
vi.mock("@/lib/computers/computer-commands", () => ({
    sendToRunner: vi.fn(async (_runnerId: string, command: unknown) => {
        sent.push(command);
        return true;
    }),
    relayNode: () => "node-a"
}));
const published: unknown[] = [];
vi.mock("@/lib/computers/computer-bus", () => ({
    onRunnerLive: vi.fn(),
    publishRunnerLive: vi.fn(async (notice: unknown) => void published.push(notice))
}));
vi.mock("@polaris/db", () => ({ prisma: { agentRunner: { findMany: vi.fn() } } }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example" }));

const model = await import("@/lib/polar/claude-subscription/model");
const turns = await import("@/lib/polar/claude-subscription/turns");
const token = await import("@/lib/polar/claude-subscription/mcp-token");

const TURN = "0190a5f2-2222-7000-8000-0000000000aa";
const RUNNER = "0190a5f2-2222-7000-8000-0000000000bb";
const APPROVAL = "0190a5f2-2222-7000-8000-0000000000cc";

beforeEach(() => {
    sent.length = 0;
    published.length = 0;
});

describe("readPrompt", () => {
    it("sends the conversation as text and starts a new turn", () => {
        const read = model.readPrompt([
            { role: "system", content: "Be brief." },
            { role: "user", content: [{ type: "text", text: "hi" }] },
            { role: "assistant", content: [{ type: "text", text: "hello" }] }
        ] as never);
        expect(read.system).toBe("Be brief.");
        expect(read.messages).toEqual([
            { role: "user", text: "hi" },
            { role: "assistant", text: "hello" }
        ]);
        expect(read.resume).toBeNull();
    });

    it("resumes the turn the person answered an approval of", () => {
        const approvalId = model.approvalIdFor(TURN, 7, APPROVAL);
        const read = model.readPrompt([
            { role: "user", content: [{ type: "text", text: "delete it" }] },
            { role: "assistant", content: [{ type: "tool-call", toolCallId: "call-1", toolName: "Bash", input: {} }] },
            { role: "tool", content: [{ type: "tool-approval-response", approvalId, approved: true }] }
        ] as never);
        expect(read.resume).toEqual({ turnId: TURN, seq: 7, answers: [{ approvalId: APPROVAL, allow: true }] });
        expect(read.calls.has("call-1")).toBe(true);
    });

    it("never resumes on an approval id it did not mint", () => {
        const read = model.readPrompt([
            { role: "tool", content: [{ type: "tool-approval-response", approvalId: "other", approved: true }] }
        ] as never);
        expect(read.resume).toBeNull();
    });
});

describe("createEventMapper", () => {
    it("maps text, reasoning, tool calls and the finish onto the chat stream", () => {
        const map = model.createEventMapper(TURN, new Set());
        const parts = [
            ...map({ kind: "reasoning", text: "thinking" }, 1),
            ...map({ kind: "text", text: "Hel" }, 2),
            ...map({ kind: "text", text: "lo" }, 3),
            ...map({ kind: "tool-call", callId: "c1", name: "mcp__polaris__tasks_list", input: { a: 1 } }, 4),
            ...map({ kind: "tool-result", callId: "c1", output: "[]", isError: false }, 5),
            ...map({ kind: "finish", reason: "stop", usage: { input: 10, output: 4 } }, 6)
        ];
        expect(parts.map((part) => part.type)).toEqual([
            "reasoning-start",
            "reasoning-delta",
            "reasoning-end",
            "text-start",
            "text-delta",
            "text-delta",
            "text-end",
            "tool-call",
            "tool-result",
            "finish"
        ]);
        expect(parts[7]).toMatchObject({ toolCallId: "c1", providerExecuted: true, dynamic: true, input: "{\"a\":1}" });
        expect(parts[8]).toMatchObject({ toolName: "mcp__polaris__tasks_list", result: "[]" });
        expect(parts[9]).toMatchObject({ finishReason: { unified: "stop" }, usage: { inputTokens: { total: 10 }, outputTokens: { total: 4 } } });
    });

    it("turns an approval into the approval card and ends the stream there", () => {
        const map = model.createEventMapper(TURN, new Set());
        const parts = map({ kind: "approval", approvalId: APPROVAL, callId: "c2", name: "Bash", input: { command: "ls" } }, 9);
        expect(parts.map((part) => part.type)).toEqual(["tool-call", "tool-approval-request", "finish"]);
        expect(parts[1]).toMatchObject({ toolCallId: "c2", approvalId: model.approvalIdFor(TURN, 9, APPROVAL) });
    });

    it("reports an error in the subscription's own words", () => {
        const map = model.createEventMapper(TURN, new Set());
        const [error] = map({ kind: "error", code: "rate-limited" }, 1);
        expect(model.subscriptionFailureOf((error as { error: unknown }).error)).toBe("rate-limited");
        expect(model.subscriptionFailureOf(new Error("x", { cause: new model.SubscriptionTurnError("signed-out") }))).toBe("signed-out");
        expect(model.subscriptionFailureOf(new Error("plain"))).toBeNull();
    });
});

describe("approvals across requests", () => {
    it("parks the turn on an approval and carries it on with the answer", async () => {
        const first = turns.runSubscriptionTurn({ userId: "u1", runnerId: RUNNER, turnId: TURN, model: "sonnet", system: "", messages: [{ role: "user", text: "go" }], effort: null, mcp: null });
        const pending = first.next();
        await vi.waitFor(() => expect(sent).toHaveLength(1));
        turns.deliverChatEvent(RUNNER, { turnId: TURN, seq: 0, event: { kind: "approval", approvalId: APPROVAL, callId: "c", name: "Bash", input: {} } });
        expect((await pending).value).toMatchObject({ kind: "approval" });
        expect((await first.next()).done).toBe(true);
        expect(turns.resumePoint(TURN)).toBe(1);

        const second = turns.runSubscriptionTurn({ userId: "u1", runnerId: RUNNER, turnId: TURN, model: "sonnet", system: "", messages: [], effort: null, mcp: null, resume: { seq: 1, answers: [{ approvalId: APPROVAL, allow: true }] } });
        const next = second.next();
        await vi.waitFor(() => expect(sent).toHaveLength(2));
        expect(sent[1]).toEqual({ type: "chat.approval", turnId: TURN, approvalId: APPROVAL, allow: true });
        turns.deliverChatEvent(RUNNER, { turnId: TURN, seq: 1, event: { kind: "finish", reason: "stop" } });
        expect((await next).value).toEqual({ kind: "finish", reason: "stop" });
        expect((await second.next()).done).toBe(true);
        expect(turns.resumePoint(TURN)).toBeNull();
    });

    it("hands an event for a turn held elsewhere to the other nodes", () => {
        expect(turns.deliverChatEvent(RUNNER, { turnId: "0190a5f2-2222-7000-8000-0000000000dd", seq: 0, event: { kind: "text", text: "x" } })).toBe(false);
        expect(published).toEqual([{ k: "chat", runnerId: RUNNER, frame: { turnId: "0190a5f2-2222-7000-8000-0000000000dd", seq: 0, event: { kind: "text", text: "x" } } }]);
    });
});

describe("turn MCP token", () => {
    const secret = "s".repeat(40);
    it("names the person and the turn until it expires", () => {
        const minted = token.mintTurnToken("u1", TURN, 1000, secret);
        expect(minted.startsWith(token.TURN_TOKEN_PREFIX)).toBe(true);
        expect(token.readTurnToken(minted, 2000, secret)).toEqual({ userId: "u1", turnId: TURN });
        expect(token.readTurnToken(minted, 1000 + token.TURN_TOKEN_TTL_MS + 1, secret)).toBeNull();
    });

    it("refuses a token signed with another secret or altered", () => {
        const minted = token.mintTurnToken("u1", TURN, 1000, secret);
        expect(token.readTurnToken(minted, 2000, "t".repeat(40))).toBeNull();
        const [body, signature] = minted.slice(token.TURN_TOKEN_PREFIX.length).split(".");
        const forged = Buffer.from(JSON.stringify({ u: "admin", t: TURN, e: 9e15 })).toString("base64url");
        expect(token.readTurnToken(`${token.TURN_TOKEN_PREFIX}${forged}.${signature}`, 2000, secret)).toBeNull();
        expect(body).toBeTruthy();
    });
});
