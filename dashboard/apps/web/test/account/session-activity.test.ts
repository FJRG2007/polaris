/**
 * Per-session activity. Two things have to hold for the session list to be
 * trustworthy: an event must be stamped with the session it actually came from,
 * and reading one session's history must be scoped by the owning user as well -
 * otherwise a guessed session id would read back as somebody else's activity.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const created: Record<string, unknown>[] = [];
const findManyArgs: Record<string, unknown>[] = [];
let rows: Record<string, unknown>[] = [];
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

const { listSessionActivity, recordAudit } = await import("../../src/lib/audit-service");

beforeEach(() => {
    created.length = 0;
    findManyArgs.length = 0;
    rows = [];
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

describe("reading one session's activity", () => {
    it("filters by the owning user as well as the session", async () => {
        await listSessionActivity("user-1", "session-1");
        expect(findManyArgs[0]?.where).toEqual({ actorId: "user-1", sessionId: "session-1" });
        expect(findManyArgs[0]?.orderBy).toEqual({ at: "desc" });
    });

    it("summarizes the target and serializes the time", async () => {
        const at = new Date("2026-07-29T10:00:00.000Z");
        rows = [
            { id: "a", action: "drive.file.uploaded", targetType: "file", targetId: "f-1", at },
            { id: "b", action: "account.pin.set", targetType: null, targetId: null, at }
        ];
        const entries = await listSessionActivity("user-1", "session-1");
        expect(entries).toEqual([
            { id: "a", action: "drive.file.uploaded", target: "file f-1", at: at.toISOString() },
            { id: "b", action: "account.pin.set", target: null, at: at.toISOString() }
        ]);
    });
});
