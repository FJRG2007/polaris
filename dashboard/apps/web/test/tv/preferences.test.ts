/**
 * What a TV's owner asks of it, and what the TV reports back: the `desired`
 * block is strict, a stored row that no longer parses counts as no choice, only
 * the account's own TVs can be changed, a report is written only when it moves,
 * and the Network filter question answers per address.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "user-1";
const TV = "0190a000-0000-7000-8000-00000000000a";
const OTHER = "0190a000-0000-7000-8000-00000000000b";

const rows = new Map<string, { userId: string; desired?: unknown; applied?: string | null }>();
const names = new Map<string, string>();
let writes = 0;

vi.mock("@polaris/db", () => ({
    prisma: {
        apiKey: {
            findFirst: async ({ where }: { where: { userId: string; id: string } }) =>
                where.userId === OWNER && where.id === TV ? { id: TV } : null,
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
            findUnique: async ({ where }: { where: { apiKeyId: string } }) =>
                rows.get(where.apiKeyId) ?? null,
            upsert: async ({
                where,
                create,
                update
            }: {
                where: { apiKeyId: string };
                create: { userId: string };
                update: Record<string, unknown>;
            }) => {
                writes += 1;
                const held = rows.get(where.apiKeyId);
                rows.set(where.apiKeyId, held ? { ...held, ...update } : { ...create });
            }
        }
    }
}));

const preferences = await import("@/lib/tv/preferences");
const { reachOf } = await import("@/lib/tv/filter-reach");
const { tvNameSchema } = await import("@/lib/tv/tv-name");

beforeEach(() => {
    rows.clear();
    names.clear();
    writes = 0;
});

describe("the desired block", () => {
    it("takes blocking, and a theme and add-ons for later", () => {
        expect(preferences.tvDesiredSchema.parse({ blocking: true })).toEqual({ blocking: true });
        expect(
            preferences.tvDesiredSchema.parse({
                blocking: false,
                theme: "aurora",
                addons: ["sleep-timer"]
            })
        ).toEqual({ blocking: false, theme: "aurora", addons: ["sleep-timer"] });
    });

    it.each([
        {},
        { blocking: "yes" },
        { blocking: true, extra: 1 },
        { blocking: true, theme: "../etc" },
        { blocking: true, addons: Array.from({ length: 51 }, (_, i) => `a${i}`) }
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
    it("turns blocking on and keeps whatever else was asked", async () => {
        rows.set(TV, { userId: OWNER, desired: { blocking: false, theme: "aurora" } });
        expect(await preferences.setTvBlocking(OWNER, TV, true)).toBe(true);
        expect(await preferences.desiredFor(TV)).toEqual({ blocking: true, theme: "aurora" });
    });

    it("creates the row the first time", async () => {
        expect(await preferences.setTvBlocking(OWNER, TV, true)).toBe(true);
        expect(rows.get(TV)).toEqual({ apiKeyId: TV, userId: OWNER, desired: { blocking: true } });
    });

    it("refuses a TV that is not the account's", async () => {
        expect(await preferences.setTvBlocking(OWNER, OTHER, true)).toBe(false);
        expect(await preferences.setTvBlocking("user-2", TV, true)).toBe(false);
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
        await preferences.noteTvBlocking(TV, OWNER, "on");
        await preferences.noteTvBlocking(TV, OWNER, "on");
        expect(writes).toBe(1);
        await preferences.noteTvBlocking(TV, OWNER, "failed");
        expect(writes).toBe(2);
        expect(rows.get(TV)?.applied).toBe("failed");
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
