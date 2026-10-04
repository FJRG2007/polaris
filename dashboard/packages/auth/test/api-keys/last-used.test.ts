/**
 * When a key's "last used" is written.
 *
 * A CLI sign-in is listed as a session, and its last-active line is this stamp.
 * Writing it on every call is a write per request for a key in steady use, so it
 * is written at most once a minute - except when the address changes, which is
 * written at once because the sessions screen and the address lock read it.
 * The day's call counter still counts every call.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const KEY = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";

interface KeyRow {
    id: string;
    lastUsedAt: Date | null;
    lastUsedIp: string | null;
    lastUsedUserAgent: string | null;
}

let row: KeyRow;
let counted = 0;

type Clause = { lastUsedAt?: null | { lt: Date }; lastUsedIp?: null | { not: string } };

/** The conditional update, evaluated the way the database would. */
function matches(where: { id: string; OR: Clause[] }): boolean {
    if (where.id !== row.id) return false;
    return where.OR.some((clause) => {
        if ("lastUsedAt" in clause) {
            if (clause.lastUsedAt === null) return row.lastUsedAt === null;
            return row.lastUsedAt !== null && row.lastUsedAt < clause.lastUsedAt!.lt;
        }
        if ("lastUsedIp" in clause) {
            if (clause.lastUsedIp === null) return row.lastUsedIp === null;
            return row.lastUsedIp !== null && row.lastUsedIp !== clause.lastUsedIp!.not;
        }
        return false;
    });
}

vi.mock("@polaris/db", () => ({
    prisma: {
        apiKey: {
            updateMany: async ({
                where,
                data
            }: {
                where: { id: string; OR: Clause[] };
                data: Partial<KeyRow>;
            }) => {
                if (!matches(where)) return { count: 0 };
                Object.assign(row, data);
                return { count: 1 };
            }
        },
        apiKeyUsage: {
            upsert: async () => ({ calls: ++counted }),
            deleteMany: async () => ({ count: 0 })
        }
    }
}));

const { LAST_USED_EVERY_MS, touchApiKey } = await import("../../src/api-keys.js");

beforeEach(() => {
    vi.useRealTimers();
    row = { id: KEY, lastUsedAt: null, lastUsedIp: null, lastUsedUserAgent: null };
    counted = 0;
});

describe("the last-used stamp", () => {
    it("is written on the first use", async () => {
        await touchApiKey(KEY, "203.0.113.4", "polaris-cli/0.4.6");
        expect(row.lastUsedIp).toBe("203.0.113.4");
        expect(row.lastUsedAt).not.toBeNull();
    });

    it("is not written again within the minute from the same address", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-04T10:00:00Z"));
        await touchApiKey(KEY, "203.0.113.4");
        vi.setSystemTime(new Date("2026-10-04T10:00:30Z"));
        await touchApiKey(KEY, "203.0.113.4");
        expect(row.lastUsedAt).toEqual(new Date("2026-10-04T10:00:00Z"));
    });

    it("is written again once the minute has passed", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-04T10:00:00Z"));
        await touchApiKey(KEY, "203.0.113.4");
        vi.setSystemTime(new Date(Date.parse("2026-10-04T10:00:00Z") + LAST_USED_EVERY_MS + 1));
        await touchApiKey(KEY, "203.0.113.4");
        expect(row.lastUsedAt?.getTime()).toBe(
            Date.parse("2026-10-04T10:00:00Z") + LAST_USED_EVERY_MS + 1
        );
    });

    it("is written at once when the address changes, whatever the minute says", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-10-04T10:00:00Z"));
        await touchApiKey(KEY, "203.0.113.4");
        vi.setSystemTime(new Date("2026-10-04T10:00:05Z"));
        await touchApiKey(KEY, "198.51.100.7");
        expect(row.lastUsedIp).toBe("198.51.100.7");
        expect(row.lastUsedAt).toEqual(new Date("2026-10-04T10:00:05Z"));
    });

    it("still counts every call", async () => {
        await touchApiKey(KEY, "203.0.113.4");
        await touchApiKey(KEY, "203.0.113.4");
        await touchApiKey(KEY, "203.0.113.4");
        expect(counted).toBe(3);
    });
});
