/**
 * The session.start frame, what a runner may write into, and that a pairing
 * code is spent by the first runner to use it.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const RUNNER = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e5f";
const OTHER_RUNNER = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e61";
const USER = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e62";
const SESSION = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e60";

interface PairingRow {
    id: string;
    userCode: string;
    kind: string;
    status: string;
    userId: string;
    expiresAt: Date;
}

const db = vi.hoisted(() => ({
    sessions: [] as Array<{ id: string; runnerId: string; place: string; state: string }>,
    pairings: [] as PairingRow[],
    runners: [] as Array<{ id: string; userId: string }>
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: {
            findFirst: async ({ where }: { where: { id: string; runnerId: string; place: string } }) =>
                db.sessions.find(
                    (row) => row.id === where.id && row.runnerId === where.runnerId && row.place === where.place
                ) ?? null,
            updateMany: async () => ({ count: 1 })
        },
        cliAuthorization: {
            findUnique: async ({ where }: { where: { userCode: string } }) =>
                db.pairings.find((row) => row.userCode === where.userCode) ?? null,
            deleteMany: async ({ where }: { where: { id: string } }) => {
                const before = db.pairings.length;
                db.pairings = db.pairings.filter((row) => row.id !== where.id);
                return { count: before - db.pairings.length };
            }
        },
        user: { findUnique: async () => ({ id: USER, bannedAt: null, disabledAt: null }) },
        agentRunner: {
            count: async () => db.runners.length,
            create: async ({ data }: { data: { userId: string } }) => {
                db.runners.push({ id: RUNNER, userId: data.userId });
                return { id: RUNNER };
            }
        }
    }
}));
vi.mock("@/lib/live/pg-listener", () => ({
    NOTIFY_PAYLOAD_LIMIT: 8000,
    pgListener: () => ({ listen: () => () => undefined })
}));
vi.mock("@/lib/agents/session-live", () => ({ touchSession: () => undefined }));
vi.mock("@/lib/agents/session-service", () => ({
    SessionRefusal: class extends Error {},
    finishSession: vi.fn(async () => undefined),
    recordSessionEvents: vi.fn(async () => undefined)
}));
vi.mock("@/lib/agents/session-hook-ingest", () => ({
    ingestHookPayload: vi.fn(async () => undefined),
    decidePermissionHook: vi.fn(async () => ({ allow: true }))
}));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: async () => "https://polaris.example" }));
vi.mock("@/lib/i18n/reader-words", () => ({ readerWords: async () => (key: string) => key }));

const { startFrame } = await import("@/lib/computers/computer-sessions");
const { handleRunnerMessage } = await import("@/lib/computers/computer-inbound");
const { claimPairing } = await import("@/lib/computers/computer-service");
const ingest = await import("@/lib/agents/session-hook-ingest");

beforeEach(() => {
    db.sessions = [{ id: SESSION, runnerId: RUNNER, place: "computer", state: "running" }];
    db.pairings = [];
    db.runners = [];
    vi.mocked(ingest.ingestHookPayload).mockClear();
});

describe("startFrame", () => {
    const session = {
        id: SESSION,
        cli: "claude",
        command: null,
        modelChoice: null,
        effort: null,
        permissionMode: "ask",
        repoFullName: "acme/widgets",
        branch: "polaris/fix",
        baseRef: "main"
    } as unknown as Parameters<typeof startFrame>[0];

    it("clones over https, reports to the session's own route, and encodes", () => {
        const frame = startFrame(session, "tok", "https://polaris.example/", "go");
        expect(frame).toMatchObject({
            type: "session.start",
            repository: { kind: "clone", url: "https://github.com/acme/widgets.git", fullName: "acme/widgets" },
            worktree: true,
            branch: "polaris/fix",
            prompt: "go",
            report: { url: `https://polaris.example/api/agents/sessions/${SESSION}/events`, token: "tok" }
        });
        expect(() => core.encodeServerFrame(frame)).not.toThrow();
    });

    it("starts a workspace with nothing checked out and caps the prompt", () => {
        const long = "x".repeat(core.RUNNER_LIMITS.promptChars + 5);
        const frame = startFrame({ ...session, repoFullName: null } as typeof session, "tok", "https://p.example", long);
        expect(frame).toMatchObject({ repository: { kind: "none" }, worktree: false, branch: "" });
        expect((frame as { prompt: string }).prompt).toHaveLength(core.RUNNER_LIMITS.promptChars);
    });

    it("works in a folder on the computer, with no clone and no worktree", () => {
        const folder = "C:\\Users\\fixture\\projects\\widgets";
        const frame = startFrame({ ...session, localFolder: folder }, "tok", "https://p.example", null);
        expect(frame).toMatchObject({ repository: { kind: "path", path: folder }, worktree: false });
        expect(() => core.encodeServerFrame(frame)).not.toThrow();
    });

    it("clones as before when the folder is empty", () => {
        const frame = startFrame({ ...session, localFolder: "" }, "tok", "https://p.example", null);
        expect(frame).toMatchObject({ repository: { kind: "clone" }, worktree: true });
    });
});

describe("handleRunnerMessage", () => {
    const hook = { v: 1, type: "hook", sessionId: SESSION, payload: { hook_event_name: "Stop" } } as const;

    it("acts on a frame for a session placed on this runner", async () => {
        await handleRunnerMessage({ runnerId: RUNNER, userId: USER }, hook);
        expect(ingest.ingestHookPayload).toHaveBeenCalledTimes(1);
    });

    it("refuses a frame for a session on another runner", async () => {
        const reply = await handleRunnerMessage({ runnerId: OTHER_RUNNER, userId: USER }, hook);
        expect(reply).toMatchObject({ type: "error", code: "unknown_session" });
        expect(ingest.ingestHookPayload).not.toHaveBeenCalled();
    });

    it("answers a permission request with the same request id", async () => {
        const requestId = "0190f5d2-6a3b-7c4d-8e5f-0a1b2c3d4e63";
        const reply = await handleRunnerMessage(
            { runnerId: RUNNER, userId: USER },
            { v: 1, type: "permission.request", requestId, sessionId: SESSION, payload: {} }
        );
        expect(reply).toEqual({ type: "permission.decision", requestId, sessionId: SESSION, decision: { allow: true } });
    });
});

describe("claimPairing", () => {
    const pairing = (id: string, userCode: string, expiresAt: Date): PairingRow => ({
        id,
        userCode,
        kind: "runner",
        status: "approved",
        userId: USER,
        expiresAt
    });

    it("mints one credential per code, however many runners race on it", async () => {
        db.pairings = [pairing("p1", "ABCD2345", new Date(Date.now() + 60_000))];
        const results = await Promise.all([
            claimPairing({ code: "ABCD2345", name: "Laptop" }),
            claimPairing({ code: "ABCD2345", name: "Laptop" })
        ]);
        const minted = results.filter((result) => result !== null);
        expect(minted).toHaveLength(1);
        expect(minted[0]!.token).toMatch(/^plr_run_/);
        expect(await claimPairing({ code: "ABCD2345", name: "Laptop" })).toBeNull();
    });

    it("refuses an expired code", async () => {
        db.pairings = [pairing("p2", "WXYZ2345", new Date(Date.now() - 1))];
        expect(await claimPairing({ code: "WXYZ2345", name: "Laptop" })).toBeNull();
    });
});
