/**
 * The browsing actions are counted, and an edited connection drops its sessions.
 *
 * Every browsing call reaches somebody's database, so past a generous budget a
 * minute they are refused before anything is dialled; and a save, a removal or
 * a newly trusted key closes the sessions held for that connection, so the next
 * call is answered by what it is now.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    allowed: true,
    limits: [] as string[],
    browse: vi.fn(async () => ({
        shape: "sql",
        namespaces: [],
        relations: [],
        namespace: null,
        databases: null,
        database: null
    })),
    stats: vi.fn(async () => ({ at: 0, engine: "postgres", gauges: [] })),
    closeSessions: vi.fn(),
    save: vi.fn(async () => "conn-1"),
    remove: vi.fn(async () => undefined)
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ unstable_rethrow: vi.fn() }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "alice" }) }));
vi.mock("@/lib/host-service", () => ({ listHosts: async () => [] }));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string) => key
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string) => {
        mocks.limits.push(key);
        return mocks.allowed ? { ok: true, retryAfterMs: 0 } : { ok: false, retryAfterMs: 4000 };
    }
}));
vi.mock("@/lib/data/browser", () => ({ browse: mocks.browse, rows: vi.fn(), run: vi.fn() }));
vi.mock("@/lib/data/stats", () => ({ engineStats: mocks.stats }));
vi.mock("@/lib/data/insights", () => ({ databaseInsights: vi.fn() }));
vi.mock("@/lib/data/open", () => ({ withDriver: vi.fn(), closeSessions: mocks.closeSessions }));
vi.mock("@/lib/data/connections", () => ({
    DataConnectionError: class DataConnectionError extends Error {},
    saveConnection: mocks.save,
    deleteConnection: mocks.remove
}));

const actions = await import("@/app/(app)/apps/databases/actions");

beforeEach(() => {
    mocks.allowed = true;
    mocks.limits.length = 0;
    mocks.browse.mockClear();
    mocks.stats.mockClear();
    mocks.closeSessions.mockClear();
});

describe("browsing budget", () => {
    it("counts browsing calls against the account", async () => {
        await actions.browseAction("conn-1", null);
        await actions.statsAction("conn-1");
        expect(mocks.limits).toEqual(["databases-read:alice", "databases-read:alice"]);
        expect(mocks.browse).toHaveBeenCalledTimes(1);
    });

    it("refuses past the budget before reaching the database", async () => {
        mocks.allowed = false;
        expect(await actions.browseAction("conn-1", null)).toEqual({
            error: "refusals.tooManyReads"
        });
        expect(await actions.runAction("conn-1", "SELECT 1")).toEqual({
            error: "refusals.tooManyReads"
        });
        expect(mocks.browse).not.toHaveBeenCalled();
    });
});

describe("sessions of a changed connection", () => {
    it("are closed on a save and on a removal", async () => {
        await actions.saveConnectionAction({ id: "conn-1" } as never);
        expect(mocks.closeSessions).toHaveBeenCalledWith("alice", "conn-1");

        mocks.closeSessions.mockClear();
        await actions.deleteConnectionAction("conn-1");
        expect(mocks.closeSessions).toHaveBeenCalledWith("alice", "conn-1");
    });
});
