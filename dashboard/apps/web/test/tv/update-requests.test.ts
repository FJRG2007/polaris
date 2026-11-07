/**
 * Asking a TV to update: one request per TV, a repeat press while one is pending
 * changes nothing, a TV already current is left alone, and a report only moves
 * the request it names.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Key {
    id: string;
    userId: string;
    clientVersion: string | null;
    clientBuild: number | null;
}
interface Row {
    apiKeyId: string;
    userId: string;
    requestId: string;
    versionName: string;
    state: string;
    reason: string | null;
    updatedAt: Date;
}

const keys = new Map<string, Key>();
const rows = new Map<string, Row>();

function matches(row: Row, where: Record<string, unknown>): boolean {
    if (where.apiKeyId !== undefined && row.apiKeyId !== where.apiKeyId) return false;
    if (where.requestId !== undefined && row.requestId !== where.requestId) return false;
    const state = where.state as { in: string[] } | undefined;
    if (state && !state.in.includes(row.state)) return false;
    return true;
}

vi.mock("@polaris/db", () => ({
    prisma: {
        apiKey: {
            findMany: async ({ where }: { where: { userId: string; id?: { in: string[] } } }) =>
                [...keys.values()]
                    .filter((key) => key.userId === where.userId)
                    .filter((key) => !where.id || where.id.in.includes(key.id))
                    .map((key) => ({ ...key, tvUpdate: rows.get(key.id) ?? null })),
            findUnique: async ({ where }: { where: { id: string } }) => keys.get(where.id) ?? null,
            update: async ({ where, data }: { where: { id: string }; data: Partial<Key> }) =>
                Object.assign(keys.get(where.id)!, data)
        },
        tvUpdateRequest: {
            findUnique: async ({ where }: { where: { apiKeyId: string } }) =>
                rows.get(where.apiKeyId) ?? null,
            create: async ({ data }: { data: Omit<Row, "updatedAt"> }) => {
                if (rows.has(data.apiKeyId))
                    throw Object.assign(new Error("unique"), { code: "P2002" });
                rows.set(data.apiKeyId, { ...data, updatedAt: new Date() });
            },
            updateMany: async ({
                where,
                data
            }: {
                where: Record<string, unknown>;
                data: Partial<Row>;
            }) => {
                let count = 0;
                for (const row of rows.values()) {
                    if (!matches(row, where)) continue;
                    Object.assign(row, data, { updatedAt: new Date() });
                    count += 1;
                }
                return { count };
            }
        }
    }
}));

const updates = await import("@/lib/tv/update-requests");

const TV_A = "0190a000-0000-7000-8000-00000000000a";
const TV_B = "0190a000-0000-7000-8000-00000000000b";

beforeEach(() => {
    keys.clear();
    rows.clear();
    keys.set(TV_A, { id: TV_A, userId: "user-1", clientVersion: "3.4", clientBuild: 13 });
    keys.set(TV_B, { id: TV_B, userId: "user-1", clientVersion: "3.5", clientBuild: 14 });
});

describe("asking for an update", () => {
    it("queues the TVs that are behind and leaves the current ones alone", async () => {
        expect(await updates.requestTvUpdates("user-1", null, "3.5")).toEqual([TV_A]);
        expect(rows.get(TV_A)).toMatchObject({ state: "queued", versionName: "3.5" });
        expect(rows.has(TV_B)).toBe(false);
    });

    it("does nothing on a repeat press while one is pending", async () => {
        await updates.requestTvUpdates("user-1", [TV_A], "3.5");
        const first = rows.get(TV_A)!.requestId;
        expect(await updates.requestTvUpdates("user-1", [TV_A], "3.5")).toEqual([]);
        expect(rows.get(TV_A)!.requestId).toBe(first);
    });

    it("replaces a finished request with a new one, keeping one row per TV", async () => {
        await updates.requestTvUpdates("user-1", [TV_A], "3.5");
        const first = rows.get(TV_A)!.requestId;
        await updates.reportTvUpdate(TV_A, { id: first, state: "failed", reason: "No space left" });
        expect(await updates.requestTvUpdates("user-1", [TV_A], "3.5")).toEqual([TV_A]);
        expect(rows.size).toBe(1);
        expect(rows.get(TV_A)).toMatchObject({ state: "queued", reason: null });
        expect(rows.get(TV_A)!.requestId).not.toBe(first);
    });

    it("lets a request nobody heard back on for a day be asked again", async () => {
        await updates.requestTvUpdates("user-1", [TV_A], "3.5");
        rows.get(TV_A)!.updatedAt = new Date(Date.now() - updates.TV_UPDATE_STALE_MS - 1);
        expect(await updates.requestTvUpdates("user-1", [TV_A], "3.5")).toEqual([TV_A]);
    });

    it("leaves alone a TV that names its version only in its user agent", async () => {
        keys.get(TV_A)!.clientBuild = null;
        expect(await updates.requestTvUpdates("user-1", null, "3.5")).toEqual([]);
        expect(rows.size).toBe(0);
    });

    it("reaches only the account's own TVs", async () => {
        expect(await updates.requestTvUpdates("user-2", [TV_A], "3.5")).toEqual([]);
        expect(rows.size).toBe(0);
    });

    it("hands the TV its pending request, and nothing once it is finished", async () => {
        await updates.requestTvUpdates("user-1", [TV_A], "3.5");
        const id = rows.get(TV_A)!.requestId;
        expect(await updates.pendingTvUpdate(TV_A)).toEqual({ id, versionName: "3.5" });
        await updates.reportTvUpdate(TV_A, { id, state: "done" });
        expect(await updates.pendingTvUpdate(TV_A)).toBeNull();
    });
});

describe("a TV reporting back", () => {
    it("moves only the request it names, and not once it is finished", async () => {
        await updates.requestTvUpdates("user-1", [TV_A], "3.5");
        const id = rows.get(TV_A)!.requestId;
        expect(await updates.reportTvUpdate(TV_A, { id: TV_B, state: "downloading" })).toBe(false);
        expect(await updates.reportTvUpdate(TV_A, { id, state: "waiting-confirmation" })).toBe(
            true
        );
        expect(rows.get(TV_A)!.state).toBe("waiting-confirmation");
        expect(await updates.reportTvUpdate(TV_A, { id, state: "done" })).toBe(true);
        expect(await updates.reportTvUpdate(TV_A, { id, state: "failed", reason: "late" })).toBe(
            false
        );
        expect(rows.get(TV_A)).toMatchObject({ state: "done", reason: null });
    });

    it("keeps a reason only on a failure", async () => {
        await updates.requestTvUpdates("user-1", [TV_A], "3.5");
        const id = rows.get(TV_A)!.requestId;
        await updates.reportTvUpdate(TV_A, { id, state: "installing", reason: "ignored" });
        expect(rows.get(TV_A)!.reason).toBeNull();
    });

    it.each([
        [{ id: "not-a-uuid", state: "done" }],
        [{ id: TV_A, state: "queued" }],
        [{ id: TV_A, state: "exploded" }],
        [{ id: TV_A, state: "failed", reason: "x".repeat(updates.TV_REASON_MAX + 1) }],
        [{ id: TV_A, state: "failed", reason: "line\nbreak" }],
        [null]
    ])("refuses a report that is not one: %j", (body) => {
        expect(updates.tvUpdateReportSchema.safeParse(body).success).toBe(false);
    });

    it("accepts every state a TV may report", () => {
        for (const state of [
            "downloading",
            "waiting-confirmation",
            "installing",
            "done",
            "failed"
        ]) {
            expect(updates.tvUpdateReportSchema.safeParse({ id: TV_A, state }).success).toBe(true);
        }
    });
});

describe("the version a TV reports", () => {
    it("is kept, and finishes the request once the TV runs it", async () => {
        await updates.requestTvUpdates("user-1", [TV_A], "3.5");
        await updates.noteTvVersion(TV_A, { versionName: "3.5", versionCode: 14 });
        expect(keys.get(TV_A)).toMatchObject({ clientVersion: "3.5", clientBuild: 14 });
        expect(rows.get(TV_A)!.state).toBe("done");
    });

    it("drops a stale build number when only the name moved", async () => {
        await updates.noteTvVersion(TV_A, { versionName: "3.6" });
        expect(keys.get(TV_A)).toMatchObject({ clientVersion: "3.6", clientBuild: null });
    });

    it("reads the version out of a TV's user agent", () => {
        expect(updates.versionFromUserAgent("polaris-tv/3.4")).toBe("3.4");
        expect(updates.versionFromUserAgent("Mozilla/5.0")).toBeNull();
        expect(updates.versionFromUserAgent(null)).toBeNull();
    });
});
