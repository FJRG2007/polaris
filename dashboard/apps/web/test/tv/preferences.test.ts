/**
 * What a TV's owner asks of it, and what the TV reports back: the `desired`
 * block is strict, a stored row that no longer parses counts as no choice, only
 * the account's own TVs on a launcher that acts on it can be changed, every
 * change is a new choice, a report is written only when it moves and only for
 * the latest choice, and the Network filter question answers per address.
 */

import { isDeepStrictEqual } from "node:util";
import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "user-1";
const TV = "0190a000-0000-7000-8000-00000000000a";
const OTHER = "0190a000-0000-7000-8000-00000000000b";

interface Row {
    apiKeyId?: string;
    userId: string;
    desired?: unknown;
    choice?: string | null;
    askedAt?: Date | null;
    applied?: string | null;
    appliedAt?: Date | null;
}
const rows = new Map<string, Row>();
const names = new Map<string, string>();
let writes = 0;
let build: number | null = 14;
/** Runs between the read and the write of a report, as another request would. */
let meanwhile: (() => Promise<unknown> | void) | null = null;

vi.mock("@polaris/db", () => ({
    Prisma: { DbNull: null },
    prisma: {
        apiKey: {
            findFirst: async ({ where }: { where: { userId: string; id: string } }) =>
                where.userId === OWNER && where.id === TV ? { clientBuild: build } : null,
            updateMany: async ({
                where,
                data
            }: {
                where: { userId: string; id: string };
                data: { clientName: string };
            }) => {
                if (where.userId !== OWNER || where.id !== TV) return { count: 0 };
                names.set(where.id, data.clientName);
                return { count: 1 };
            }
        },
        tvPreference: {
            findUnique: async ({ where }: { where: { apiKeyId: string } }) => {
                const row = rows.get(where.apiKeyId);
                const found = row ? { ...row, choice: row.choice ?? null } : null;
                const run = meanwhile;
                meanwhile = null;
                await run?.();
                return found;
            },
            upsert: async ({
                where,
                create,
                update
            }: {
                where: { apiKeyId: string };
                create: Row;
                update: Partial<Row>;
            }) => {
                writes += 1;
                const held = rows.get(where.apiKeyId);
                rows.set(where.apiKeyId, held ? { ...held, ...update } : { ...create });
            },
            updateMany: async ({
                where,
                data
            }: {
                where: { apiKeyId: string; choice?: string | null; desired?: { equals: unknown } };
                data: Partial<Row>;
            }) => {
                const held = rows.get(where.apiKeyId);
                if (!held) return { count: 0 };
                if ("choice" in where && (held.choice ?? null) !== where.choice)
                    return { count: 0 };
                if (
                    where.desired &&
                    !isDeepStrictEqual(held.desired ?? null, where.desired.equals)
                ) {
                    return { count: 0 };
                }
                writes += 1;
                rows.set(where.apiKeyId, { ...held, ...data });
                return { count: 1 };
            },
            create: async ({ data }: { data: Row & { apiKeyId: string } }) => {
                if (rows.has(data.apiKeyId)) {
                    throw Object.assign(new Error("taken"), { code: "P2002" });
                }
                writes += 1;
                rows.set(data.apiKeyId, { ...data });
            }
        }
    }
}));

const preferences = await import("@/lib/tv/preferences");
const { reachOf } = await import("@/lib/tv/filter-reach");
const { tvNameSchema } = await import("@/lib/tv/tv-name");

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

beforeEach(() => {
    rows.clear();
    names.clear();
    writes = 0;
    build = 14;
    meanwhile = null;
});

describe("the desired block", () => {
    it("takes blocking", () => {
        expect(preferences.tvDesiredSchema.parse({ blocking: true })).toEqual({ blocking: true });
    });

    it.each([
        { blocking: "yes" },
        { blocking: true, extra: 1 },
        { blocking: true, theme: "aurora" }
    ])("refuses %j", (value) => {
        expect(preferences.tvDesiredSchema.safeParse(value).success).toBe(false);
    });

    it("reads a stored row that no longer parses as no choice", () => {
        expect(preferences.readDesired({ blocking: 1 })).toBeNull();
        expect(preferences.readDesired(null)).toBeNull();
        expect(preferences.readReport("bogus")).toBeNull();
        expect(preferences.readReport("no-filter")).toBe("no-filter");
    });
});

describe("changing a TV from /account/tv", () => {
    it("creates the row the first time, with a choice for the TV to answer", async () => {
        expect(await preferences.setTvBlocking(OWNER, TV, true)).toBe("done");
        const row = rows.get(TV);
        expect(row?.desired).toEqual({ blocking: true });
        expect(row?.choice).toMatch(UUID);
        expect(row?.applied).toBeNull();
        expect(await preferences.desiredFor(TV)).toEqual({ blocking: true, choice: row?.choice });
    });

    it("makes every change a new choice and forgets what the TV said about the last one", async () => {
        await preferences.setTvBlocking(OWNER, TV, true);
        const first = rows.get(TV)?.choice ?? null;
        await preferences.noteTvBlocking(TV, OWNER, { report: "no-permission", choice: first });
        expect(rows.get(TV)?.applied).toBe("no-permission");
        await preferences.setTvBlocking(OWNER, TV, true);
        expect(rows.get(TV)?.choice).not.toBe(first);
        expect(rows.get(TV)?.applied).toBeNull();
    });

    it("refuses a TV that is not the account's", async () => {
        expect(await preferences.setTvBlocking(OWNER, OTHER, true)).toBe("notATv");
        expect(await preferences.setTvBlocking("user-2", TV, true)).toBe("notATv");
        expect(writes).toBe(0);
    });

    it.each([null, 13])("refuses a launcher that does not act on it (build %s)", async (code) => {
        build = code;
        expect(await preferences.setTvBlocking(OWNER, TV, true)).toBe("tooOld");
        expect(writes).toBe(0);
    });

    it("renames only the account's own TV", async () => {
        expect(await preferences.renameTv(OWNER, TV, "Living room")).toBe(true);
        expect(await preferences.renameTv("user-2", TV, "Mine now")).toBe(false);
        expect(names.get(TV)).toBe("Living room");
    });

    it.each(["", "   ", "a".repeat(61), "Line\nbreak"])("refuses the name %j", (name) => {
        expect(tvNameSchema.safeParse(name).success).toBe(false);
    });
});

describe("what the TV reports", () => {
    it("is written only when it changes", async () => {
        await preferences.noteTvBlocking(TV, OWNER, { report: "on", choice: null });
        await preferences.noteTvBlocking(TV, OWNER, { report: "on", choice: null });
        expect(writes).toBe(1);
        await preferences.noteTvBlocking(TV, OWNER, { report: "failed", choice: null });
        expect(writes).toBe(2);
        expect(rows.get(TV)?.applied).toBe("failed");
    });

    it("is kept for the latest choice only", async () => {
        await preferences.setTvBlocking(OWNER, TV, true);
        const first = rows.get(TV)?.choice ?? null;
        await preferences.setTvBlocking(OWNER, TV, true);
        const second = rows.get(TV)?.choice ?? null;
        await preferences.noteTvBlocking(TV, OWNER, { report: "no-permission", choice: first });
        await preferences.noteTvBlocking(TV, OWNER, { report: "on", choice: null });
        expect(rows.get(TV)?.applied).toBeNull();
        await preferences.noteTvBlocking(TV, OWNER, { report: "on", choice: second });
        expect(rows.get(TV)?.applied).toBe("on");
    });

    it("never lands on a choice the owner made while it was being written", async () => {
        await preferences.setTvBlocking(OWNER, TV, true);
        const first = rows.get(TV)?.choice ?? null;
        meanwhile = () => preferences.setTvBlocking(OWNER, TV, false);
        await preferences.noteTvBlocking(TV, OWNER, { report: "failed", choice: first });
        expect(rows.get(TV)?.desired).toEqual({ blocking: false });
        expect(rows.get(TV)?.applied).toBeNull();
    });

    it("keeps a theme picked while Block ads and trackers was being written", async () => {
        const theme = { id: "aerial", choice: "0190a000-0000-7000-8000-0000000000aa" };
        rows.set(TV, { apiKeyId: TV, userId: OWNER, desired: { blocking: false }, choice: null });
        meanwhile = () =>
            void rows.set(TV, { ...rows.get(TV)!, desired: { blocking: false, theme } });
        expect(await preferences.setTvBlocking(OWNER, TV, true)).toBe("done");
        expect(rows.get(TV)?.desired).toEqual({ blocking: true, theme });
    });

    it("survives the owner creating the row at the same moment", async () => {
        meanwhile = () =>
            void rows.set(TV, { apiKeyId: TV, userId: OWNER, desired: null, choice: null });
        await preferences.noteTvBlocking(TV, OWNER, { report: "on", choice: null });
        expect(rows.get(TV)?.applied).toBe("on");
    });

    it("reads the choice it answers from the poll, and ignores a malformed one", () => {
        const choice = "0190A000-0000-7000-8000-0000000000AA";
        const at = (query: string) =>
            preferences.reportedBlocking(
                new Request(`https://polaris.example/api/tv/state${query}`)
            );
        expect(at(`?blocking=on&blockingChoice=${choice}`)).toEqual({
            report: "on",
            choice: choice.toLowerCase()
        });
        expect(at("?blocking=on&blockingChoice=nope")).toEqual({ report: "on", choice: null });
        expect(at(`?blockingChoice=${choice}`)).toBeNull();
    });
});

describe("whether a TV reaches the Network filter", () => {
    const device = (address: string, queries = 3) => ({
        address,
        name: "",
        queries,
        blocked: 0,
        first: 0,
        last: 0
    });

    it("finds the TV's address among the devices the filter saw", () => {
        const seen = { devices: [device("192.168.1.20")], logOff: false };
        expect(reachOf("192.168.1.20", seen)).toBe("reaching");
        expect(reachOf("::ffff:192.168.1.20", seen)).toBe("reaching");
        expect(reachOf("192.168.1.21", seen)).toBe("notReaching");
    });

    it("says the filter is off, or that it cannot tell", () => {
        expect(reachOf("192.168.1.20", null)).toBe("filterOff");
        expect(reachOf(null, { devices: [], logOff: false })).toBe("unknown");
        expect(reachOf("192.168.1.20", { devices: [], logOff: true })).toBe("unknown");
    });
});
