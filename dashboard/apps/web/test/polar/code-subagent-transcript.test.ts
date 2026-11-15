/**
 * A Code subagent's own transcript is asked by session and agent id, never by
 * path: the path is looked up on the server, only for somebody who may read
 * the session, and handed to the reader that decides whether it may be opened.
 */

import { NextResponse } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION = "11111111-1111-4111-8111-111111111111";
const PATH = "~/.claude/projects/-work-repo/abc/subagents/agent-a1.jsonl";

const state = vi.hoisted(() => ({
    held: new Set<string>(),
    owner: true,
    signedIn: true,
    looked: [] as { sessionId: string; agentId: string }[],
    read: [] as { sessionId: string; path: string | null }[]
}));

vi.mock("@/lib/session", () => ({
    userHasManage: async (_user: unknown, permission: string) => state.held.has(permission)
}));
vi.mock("@/lib/agents/session-service", () => ({
    getSession: async () => (state.owner ? { id: SESSION } : null),
    hideSessionFromPolar: async () => true,
    renameSession: async () => true,
    sessionSubagentEvents: async () => [],
    subagentTranscriptRef: async (sessionId: string, agentId: string) => {
        state.looked.push({ sessionId, agentId });
        return PATH;
    }
}));
vi.mock("@/lib/agents/session-files", () => ({
    readSubagentTranscript: async (sessionId: string, path: string | null) => {
        state.read.push({ sessionId, path });
        return { kind: "rows", rows: [], truncated: false };
    }
}));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string) => `t:${key}`
}));
vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/polar/access", async (load) => ({
    ...(await load<object>()),
    polarCaller: async () =>
        state.signedIn
            ? { id: "u1", isAdmin: false }
            : NextResponse.json({ error: "Unauthorized" }, { status: 401 })
}));

const { polarCodeSubagentTranscript } = await import("@/lib/polar/code");
const { GET } = await import("@/app/api/polar/code/subagent/route");

const USER = { id: "u1", isAdmin: false } as never;

beforeEach(() => {
    state.held = new Set(["agents.read"]);
    state.owner = true;
    state.signedIn = true;
    state.looked = [];
    state.read = [];
});

describe("polarCodeSubagentTranscript", () => {
    it("looks the path up by session and agent id and reads it", async () => {
        const answer = await polarCodeSubagentTranscript(USER, { sessionId: SESSION, agentId: "a1" });
        expect(answer).toEqual({ kind: "rows", rows: [], truncated: false });
        expect(state.looked).toEqual([{ sessionId: SESSION, agentId: "a1" }]);
        expect(state.read).toEqual([{ sessionId: SESSION, path: PATH }]);
    });

    it("refuses an account without the Agents permission", async () => {
        state.held = new Set();
        expect(await polarCodeSubagentTranscript(USER, { sessionId: SESSION, agentId: "a1" })).toBeNull();
        expect(state.read).toEqual([]);
    });

    it("refuses a session this person may not read", async () => {
        state.owner = false;
        expect(await polarCodeSubagentTranscript(USER, { sessionId: SESSION, agentId: "a1" })).toBeNull();
        expect(state.looked).toEqual([]);
        expect(state.read).toEqual([]);
    });

    it("refuses a path, a malformed id, or anything extra in place of an agent id", async () => {
        for (const input of [
            { sessionId: SESSION, agentId: "../../etc/passwd" },
            { sessionId: SESSION, agentId: "" },
            { sessionId: "not-a-session", agentId: "a1" },
            { sessionId: SESSION, agentId: "a1", path: PATH },
            null
        ])
            expect(await polarCodeSubagentTranscript(USER, input)).toBeNull();
        expect(state.read).toEqual([]);
    });
});

describe("GET /api/polar/code/subagent", () => {
    const ask = (query: string) => GET(new Request(`http://localhost/api/polar/code/subagent?${query}`));

    it("answers the transcript for a reader", async () => {
        const response = await ask(`sessionId=${SESSION}&agentId=a1`);
        expect(response.status).toBe(200);
        expect(state.read).toHaveLength(1);
    });

    it("refuses somebody not signed in", async () => {
        state.signedIn = false;
        const response = await ask(`sessionId=${SESSION}&agentId=a1`);
        expect(response.status).toBe(401);
        expect(state.read).toEqual([]);
    });

    it("answers nothing, and reads nothing, for a path in the query", async () => {
        const response = await ask(`sessionId=${SESSION}&agentId=a1&path=${encodeURIComponent("/etc/passwd")}`);
        expect(response.status).toBe(200);
        expect(((await response.json()) as { value: unknown }).value).toBeNull();
        expect(state.read).toEqual([]);
    });
});
