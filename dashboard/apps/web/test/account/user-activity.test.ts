/**
 * A user's own activity. Two things have to hold for the account's activity
 * screen to be trustworthy: an event must be stamped with the session it
 * actually came from, and reading the history must be scoped by the owning user -
 * otherwise a guessed session id would read back as somebody else's activity.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const created: Record<string, unknown>[] = [];
const findManyArgs: Record<string, unknown>[] = [];
const groupByArgs: Record<string, unknown>[] = [];
let rows: Record<string, unknown>[] = [];
let groups: Record<string, unknown>[] = [];
let currentSessionId: string | undefined = "11111111-1111-4111-8111-111111111111";

vi.mock("@polaris/db", () => ({
    prisma: {
        auditLog: {
            create: async ({ data }: { data: Record<string, unknown> }) => {
                created.push(data);
                return data;
            },
            findMany: async (args: Record<string, unknown>) => {
                findManyArgs.push(args);
                return rows;
            },
            groupBy: async (args: Record<string, unknown>) => {
                groupByArgs.push(args);
                return groups;
            }
        }
    }
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

vi.mock("@/lib/auth", () => ({
    auth: {
        api: {
            getSession: async () => (currentSessionId ? { session: { id: currentSessionId } } : null)
        }
    }
}));

const { listUserActivity, listUserActivitySessions, recordAudit } = await import("../../src/lib/audit-service");

beforeEach(() => {
    created.length = 0;
    findManyArgs.length = 0;
    groupByArgs.length = 0;
    rows = [];
    groups = [];
    currentSessionId = "11111111-1111-4111-8111-111111111111";
});

describe("recording activity", () => {
    it("stamps the session the action arrived on", async () => {
        await recordAudit({ actorId: "user-1", action: "account.password.changed" });
        expect(created[0]?.sessionId).toBe("11111111-1111-4111-8111-111111111111");
    });

    it("keeps an explicitly given session over the request's own", async () => {
        await recordAudit({ actorId: "user-1", action: "account.session.revoked", sessionId: "other-session" });
        expect(created[0]?.sessionId).toBe("other-session");
    });

    it("records nothing for the session when the request carries none", async () => {
        currentSessionId = undefined;
        await recordAudit({ actorId: null, action: "system.job.ran" });
        expect(created[0]?.sessionId).toBeUndefined();
    });
});

describe("reading a user's activity", () => {
    it("scopes the whole history to the owning user", async () => {
        await listUserActivity("user-1");
        expect(findManyArgs[0]?.where).toEqual({ actorId: "user-1" });
        expect(findManyArgs[0]?.orderBy).toEqual({ at: "desc" });
    });

    it("filters by the owning user as well as the session", async () => {
        await listUserActivity("user-1", { sessionId: "session-1" });
        expect(findManyArgs[0]?.where).toEqual({ actorId: "user-1", sessionId: "session-1" });
    });

    it("asks for the entries that came from no session at all", async () => {
        await listUserActivity("user-1", { sessionId: null });
        expect(findManyArgs[0]?.where).toEqual({ actorId: "user-1", sessionId: null });
    });

    it("summarizes the target and serializes the time", async () => {
        const at = new Date("2026-07-29T10:00:00.000Z");
        rows = [
            {
                id: "a",
                action: "drive.file.uploaded",
                targetType: "file",
                targetId: "f-1",
                metadata: '{"path":"/photos"}',
                sessionId: "session-1",
                at
            },
            { id: "b", action: "account.pin.set", targetType: null, targetId: null, metadata: null, sessionId: null, at }
        ];
        const entries = await listUserActivity("user-1");
        expect(entries).toEqual([
            {
                id: "a",
                at: at.toISOString(),
                action: "drive.file.uploaded",
                target: "file f-1",
                metadata: '{"path":"/photos"}',
                sessionId: "session-1"
            },
            {
                id: "b",
                at: at.toISOString(),
                action: "account.pin.set",
                target: "",
                metadata: "",
                sessionId: null
            }
        ]);
    });
});

describe("the sessions a history was written from", () => {
    it("groups the user's own entries, newest session first", async () => {
        groups = [
            { sessionId: "older", _max: { at: new Date("2026-07-01T10:00:00.000Z") } },
            { sessionId: null, _max: { at: new Date("2026-07-30T10:00:00.000Z") } },
            { sessionId: "newer", _max: { at: new Date("2026-07-31T10:00:00.000Z") } }
        ];
        const sessions = await listUserActivitySessions("user-1");
        expect(groupByArgs[0]?.where).toEqual({ actorId: "user-1" });
        expect(sessions.map((session) => session.id)).toEqual(["newer", null, "older"]);
        expect(sessions[0]?.lastAt).toBe("2026-07-31T10:00:00.000Z");
    });
});
