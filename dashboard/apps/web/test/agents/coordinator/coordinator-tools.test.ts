/**
 * The coordinator's MCP verbs at their boundary: only a session coordinating
 * an active run may call them, only on that run's own children, spawns are
 * held to a budget and keyed by the caller, and every answer has its shape.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
    class OrchestrationRefusal extends Error {}
    class SessionRefusal extends Error {}
    return {
        OrchestrationRefusal,
        SessionRefusal,
        runForCoordinator: vi.fn(),
        childSession: vi.fn(),
        spawnWorker: vi.fn(),
        runChildren: vi.fn(),
        getSession: vi.fn(),
        addSessionMessage: vi.fn(),
        setAutoFeedback: vi.fn(),
        promptSession: vi.fn(),
        claimSessionPullRequest: vi.fn(),
        sessionPreviewPorts: vi.fn(),
        rateLimit: vi.fn()
    };
});

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/agents/orchestration-service", () => ({
    OrchestrationRefusal: mocks.OrchestrationRefusal,
    runForCoordinator: mocks.runForCoordinator,
    childSession: mocks.childSession,
    spawnWorker: mocks.spawnWorker,
    runChildren: mocks.runChildren
}));
vi.mock("@/lib/agents/session-service", () => ({
    SessionRefusal: mocks.SessionRefusal,
    getSession: mocks.getSession,
    addSessionMessage: mocks.addSessionMessage,
    setAutoFeedback: mocks.setAutoFeedback
}));
vi.mock("@/lib/agents/session-runtime", () => ({ promptSession: mocks.promptSession }));
vi.mock("@/lib/agents/session-api", () => ({ promptRefusal: () => null, startAgentSession: vi.fn() }));
vi.mock("@/lib/agents/session-review", () => ({
    claimSessionPullRequest: mocks.claimSessionPullRequest,
    claimDeps: () => ({})
}));
vi.mock("@/lib/agents/session-preview", () => ({ sessionPreviewPorts: mocks.sessionPreviewPorts }));
vi.mock("@/lib/rate-limit-service", () => ({ rateLimit: mocks.rateLimit }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example/" }));

const { COORDINATOR_TOOLS } = await import("@/lib/mcp/tools/coordinator");
const { McpRefusal } = await import("@/lib/mcp/protocol");

const RUN = { id: "11111111-1111-4111-8111-111111111111", ownerId: "u1" };
const COORD = "22222222-2222-4222-8222-222222222222";
const CHILD = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const caller = { userId: "u1", isAdmin: false, scopes: ["agents.coordinate"], sessionId: COORD };

type Run = (input: unknown, who: unknown) => Promise<{ text: string; structured?: unknown }>;

function tool(name: string) {
    const found = COORDINATOR_TOOLS.find((entry) => entry.name === name)!;
    return {
        found,
        run: (input: unknown, who: unknown = caller) => (found.run as unknown as Run)(found.input.parse(input), who)
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.runForCoordinator.mockResolvedValue(RUN);
    mocks.childSession.mockResolvedValue({ taskId: TASK, sessionId: CHILD });
    mocks.getSession.mockImplementation(async (id: string) => ({ id, title: "w", state: "idle" }));
    mocks.rateLimit.mockResolvedValue({ ok: true, retryAfterMs: 0 });
});

describe("coordinator tools", () => {
    it("are all held to agents.coordinate", () => {
        expect(COORDINATOR_TOOLS.map((entry) => entry.scope)).toEqual(Array(5).fill("agents.coordinate"));
    });

    it("refuse a caller that is not a session, and a session with no run", async () => {
        await expect(tool("coordinator_children").run({}, { ...caller, sessionId: null })).rejects.toBeInstanceOf(
            McpRefusal
        );
        mocks.runForCoordinator.mockResolvedValue(null);
        await expect(tool("coordinator_children").run({})).rejects.toBeInstanceOf(McpRefusal);
    });

    it("refuse a session that is not a child of the run", async () => {
        mocks.childSession.mockResolvedValue(null);
        await expect(tool("coordinator_send").run({ sessionId: CHILD, message: "hi" })).rejects.toThrow(
            "No worker with that id"
        );
        expect(mocks.promptSession).not.toHaveBeenCalled();
        await expect(tool("coordinator_preview").run({ sessionId: CHILD })).rejects.toBeInstanceOf(McpRefusal);
        await expect(tool("coordinator_claim_pr").run({ sessionId: CHILD, pullRequest: "7" })).rejects.toBeInstanceOf(
            McpRefusal
        );
        expect(mocks.claimSessionPullRequest).not.toHaveBeenCalled();
    });

    it("spawns with the caller's key and a budget, and validates its input", async () => {
        mocks.spawnWorker.mockResolvedValue({ taskId: TASK, sessionId: CHILD, status: "dispatched" });
        const result = await tool("coordinator_spawn").run({ clientKey: "fix-1", title: "Fix", prompt: "Do it" });
        expect(mocks.spawnWorker).toHaveBeenCalledWith(RUN, {
            clientKey: "fix-1",
            title: "Fix",
            prompt: "Do it",
            role: "worker",
            agent: null,
            model: null
        });
        expect(result.structured).toEqual({ taskId: TASK, sessionId: CHILD, status: "dispatched" });
        expect(mocks.rateLimit).toHaveBeenCalledWith(`coordinator-spawn:${COORD}`, expect.any(Number), 60_000);
        const input = tool("coordinator_spawn").found.input;
        expect(input.safeParse({ clientKey: "a b", title: "x", prompt: "y" }).success).toBe(false);
        expect(input.safeParse({ clientKey: "k", title: "x", prompt: "y", model: "bad" }).success).toBe(false);
        expect(input.safeParse({ clientKey: "k", title: "x", prompt: "y", extra: 1 }).success).toBe(false);
    });

    it("refuses a spawn over budget without spawning", async () => {
        mocks.rateLimit.mockResolvedValue({ ok: false, retryAfterMs: 4200 });
        await expect(tool("coordinator_spawn").run({ clientKey: "k", title: "x", prompt: "y" })).rejects.toThrow(
            "Try again in 5 s"
        );
        expect(mocks.spawnWorker).not.toHaveBeenCalled();
    });

    it("passes a service refusal on in its own words", async () => {
        mocks.spawnWorker.mockRejectedValue(new mocks.OrchestrationRefusal("That run is not going any more."));
        await expect(tool("coordinator_spawn").run({ clientKey: "k", title: "x", prompt: "y" })).rejects.toThrow(
            "That run is not going any more."
        );
    });

    it("sends to a child as a message from the coordinator", async () => {
        await tool("coordinator_send").run({ sessionId: CHILD, message: "Focus on the API." });
        const [id, text] = mocks.promptSession.mock.calls[0]!;
        expect(id).toBe(CHILD);
        expect(text).toContain(COORD);
        expect(text).toContain("Focus on the API.");
    });

    it("a review claim turns feedback off first, never takes over, and restores it when refused", async () => {
        mocks.setAutoFeedback.mockResolvedValue(true);
        mocks.claimSessionPullRequest.mockResolvedValue({ kind: "refused", reason: "taken" });
        await expect(
            tool("coordinator_claim_pr").run({ sessionId: CHILD, pullRequest: "7", takeover: true, review: true })
        ).rejects.toThrow("Another live session");
        expect(mocks.claimSessionPullRequest.mock.calls[0]![2]).toEqual({ takeover: false });
        expect(mocks.setAutoFeedback.mock.calls).toEqual([
            [CHILD, false],
            [CHILD, true]
        ]);
    });

    it("lists children and preview addresses in their shapes", async () => {
        mocks.runChildren.mockResolvedValue([
            {
                taskId: TASK,
                title: "Fix",
                role: "worker",
                taskStatus: "dispatched",
                sessionId: CHILD,
                agent: "claude",
                model: null,
                branch: "b",
                status: "ci_failed",
                pullRequest: { number: 7, url: "https://github.com/o/r/pull/7" },
                checks: "failing",
                review: "none"
            }
        ]);
        const list = await tool("coordinator_children").run({});
        expect(list.text).toContain("[ci_failed]");
        mocks.sessionPreviewPorts.mockResolvedValue({
            kind: "ports",
            base: "/api/agents/preview/x/sig",
            open: [3000],
            inside: [5173]
        });
        const preview = await tool("coordinator_preview").run({ sessionId: CHILD });
        expect(preview.structured).toEqual({
            sessionId: CHILD,
            urls: [{ port: 3000, url: "https://polaris.example/api/agents/preview/x/sig/3000/" }],
            loopbackOnly: [5173]
        });
    });
});
