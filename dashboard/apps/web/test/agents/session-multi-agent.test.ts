/**
 * Several agents on one project: a session starting another beside it, and
 * one session messaging another.
 *
 * The tools are what a session's own token reaches over MCP
 * (`lib/mcp/tools/sessions.ts`). What these assert is the part that runs in
 * Polaris - where the new session is placed and what text reaches the other
 * agent's prompt. Typing it into the other terminal is `promptSession`, which
 * needs a running container and is not exercised here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    sessionCapacity: vi.fn(),
    createSession: vi.fn(),
    addSessionMessage: vi.fn(),
    startSession: vi.fn(),
    deliverFirstPrompt: vi.fn(),
    promptSession: vi.fn(),
    getSession: vi.fn(),
    findFirst: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn()
}));

vi.mock("next/server", () => ({ after: (fn: () => unknown) => fn() }));
vi.mock("@polaris/db", () => ({
    prisma: {
        agentRepo: { findFirst: mocks.findFirst },
        agentSession: { count: mocks.count, findUnique: mocks.findUnique }
    }
}));
vi.mock("@/lib/agents/session-capacity", async () => {
    const actual = await vi.importActual<typeof import("@/lib/agents/session-capacity")>(
        "@/lib/agents/session-capacity"
    );
    return { ...actual, sessionCapacity: mocks.sessionCapacity };
});
vi.mock("@/lib/agents/session-service", () => {
    class SessionRefusal extends Error {}
    return {
        SessionRefusal,
        createSession: mocks.createSession,
        addSessionMessage: mocks.addSessionMessage,
        readableFailure: () => "failed",
        reissueSessionToken: vi.fn(),
        getSession: mocks.getSession,
        listSessions: vi.fn()
    };
});
vi.mock("@/lib/agents/session-runtime", () => ({
    startSession: mocks.startSession,
    deliverFirstPrompt: mocks.deliverFirstPrompt,
    promptSession: mocks.promptSession
}));

const { SESSION_TOOLS, fromSession } = await import("@/lib/mcp/tools/sessions");
const tool = (name: string) => SESSION_TOOLS.find((entry) => entry.name === name)!;

const BACKEND = "11111111-1111-4111-8111-111111111111";
const FRONTEND = "22222222-2222-4222-8222-222222222222";
const asSession = (sessionId: string) => ({
    userId: "user-1",
    isAdmin: false,
    scopes: ["agents.read", "agents.manage"],
    sessionId
});
const workspaceOnServer = {
    id: BACKEND,
    title: "Backend",
    repoId: null,
    place: "host",
    sharedHome: true,
    hostId: "host-1",
    state: "working"
};

beforeEach(() => {
    vi.clearAllMocks();
    mocks.sessionCapacity.mockResolvedValue({ mine: 1, perAccount: 3, total: 1, totalCeiling: 12 });
    mocks.createSession.mockImplementation(async (input: { title: string }) => ({
        session: { id: `new-${input.title}`, branch: "", state: "starting" },
        token: "t"
    }));
});

describe("agent_session_start from inside a session", () => {
    it("starts the new agent in the caller's own workspace, on the caller's server", async () => {
        mocks.getSession.mockResolvedValue(workspaceOnServer);
        await tool("agent_session_start").run(
            { repo: "", title: "Tests", prompt: "Write the tests", agent: "claude", baseRef: "" } as never,
            asSession(BACKEND) as never
        );
        const created = mocks.createSession.mock.calls[0][0];
        expect(created).toMatchObject({ repoId: null, place: "host", hostId: "host-1" });
        // A model never puts work on the machine everybody shares.
        expect(created.sharedHome).toBe(false);
        expect(mocks.startSession).toHaveBeenCalledOnce();
    });

    it("starts two side by side in that workspace within the account's ceiling", async () => {
        mocks.getSession.mockResolvedValue({ ...workspaceOnServer, place: "local", hostId: null });
        for (const title of ["Api", "Docs"]) {
            await tool("agent_session_start").run(
                { repo: "", title, prompt: "Go", agent: "claude", baseRef: "" } as never,
                asSession(BACKEND) as never
            );
        }
        expect(mocks.startSession).toHaveBeenCalledTimes(2);
        expect(mocks.createSession.mock.calls.map((call) => call[0].queued)).toEqual([
            undefined,
            undefined
        ]);
    });

    it("lands on the caller's repository, on a branch of its own, when it has one", async () => {
        mocks.getSession.mockResolvedValue({ ...workspaceOnServer, repoId: "repo-9", place: "local" });
        await tool("agent_session_start").run(
            { repo: "", title: "Api", prompt: "Go", agent: "claude", baseRef: "" } as never,
            asSession(BACKEND) as never
        );
        expect(mocks.createSession.mock.calls[0][0]).toMatchObject({
            repoId: "repo-9",
            place: "local",
            hostId: null
        });
    });

    it("opens a workspace on the person's own machine for a key with no session", async () => {
        await tool("agent_session_start").run(
            { repo: "", title: "Api", prompt: "Go", agent: "claude", baseRef: "" } as never,
            { userId: "user-1", isAdmin: false, scopes: ["agents.manage"], keyId: "k" } as never
        );
        expect(mocks.getSession).not.toHaveBeenCalled();
        expect(mocks.createSession.mock.calls[0][0]).toMatchObject({
            repoId: null,
            place: "local",
            hostId: null
        });
    });
});

describe("agent_session_prompt between sessions", () => {
    it("tells the receiving agent who wrote and how to answer", async () => {
        mocks.getSession.mockImplementation(async (id: string) =>
            id === BACKEND ? workspaceOnServer : { ...workspaceOnServer, id: FRONTEND, title: "Frontend" }
        );
        await tool("agent_session_prompt").run(
            { sessionId: FRONTEND, text: "Which port does the API use?" } as never,
            asSession(BACKEND) as never
        );
        const sent = mocks.promptSession.mock.calls[0];
        expect(sent[0]).toBe(FRONTEND);
        expect(sent[1]).toContain(`"Backend" (${BACKEND})`);
        expect(sent[1]).toContain(`agent_session_prompt with sessionId ${BACKEND}`);
        expect(sent[1].endsWith("Which port does the API use?")).toBe(true);
        expect(mocks.addSessionMessage).toHaveBeenCalledWith(FRONTEND, "user", sent[1], "user-1");
    });

    it("passes a person's own message through unchanged", async () => {
        mocks.getSession.mockResolvedValue({ ...workspaceOnServer, id: FRONTEND });
        await tool("agent_session_prompt").run(
            { sessionId: FRONTEND, text: "Ship it" } as never,
            { userId: "user-1", isAdmin: false, scopes: ["agents.manage"], keyId: "k" } as never
        );
        expect(mocks.promptSession).toHaveBeenCalledWith(FRONTEND, "Ship it");
    });

    it("refuses a session messaging itself", async () => {
        mocks.getSession.mockResolvedValue(workspaceOnServer);
        await expect(
            tool("agent_session_prompt").run(
                { sessionId: BACKEND, text: "Hello" } as never,
                asSession(BACKEND) as never
            )
        ).rejects.toThrow("That is this session");
        expect(mocks.promptSession).not.toHaveBeenCalled();
    });

    it("formats the header on one line ahead of the text", () => {
        expect(fromSession({ id: "a", title: "Api" }, "hi").split("\n\n")).toEqual([
            '[Message from the agent session "Api" (a). To reply, call agent_session_prompt with sessionId a.]',
            "hi"
        ]);
    });
});
