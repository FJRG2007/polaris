/**
 * A burst of page loads reading the same setting is one query, and a write
 * keeps every read that starts after it off a query from before it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let rows = new Map<string, string>();
let hold: Promise<void> | null = null;
const findUnique = vi.fn(async ({ where }: { where: { key: string } }) => {
    const value = rows.get(where.key);
    if (hold) await hold;
    return value === undefined ? null : { value };
});
const findMany = vi.fn(async ({ where }: { where: { key: { in: string[] } } }) =>
    where.key.in.flatMap((key) => (rows.has(key) ? [{ key, value: rows.get(key)! }] : []))
);

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            findUnique: (args: { where: { key: string } }) => findUnique(args),
            findMany: (args: { where: { key: { in: string[] } } }) => findMany(args),
            upsert: async ({ where, update }: { where: { key: string }; update: { value: string } }) => {
                rows.set(where.key, update.value);
                return { key: where.key };
            },
            deleteMany: async ({ where }: { where: { key: string } }) => {
                rows.delete(where.key);
                return { count: 1 };
            }
        }
    }
}));

const { getSetting, getSettings, setSetting } = await import("@/lib/setting-store");

beforeEach(() => {
    rows = new Map([["domain.app", "polaris.example.test"]]);
    hold = null;
    findUnique.mockClear();
    findMany.mockClear();
});

describe("setting reads", () => {
    it("answers 1000 concurrent reads of one key with one query", async () => {
        const answers = await Promise.all(Array.from({ length: 1000 }, () => getSetting("domain.app")));
        expect(findUnique).toHaveBeenCalledTimes(1);
        expect(new Set(answers)).toEqual(new Set(["polaris.example.test"]));
    });

    it("keeps nothing once the read has landed", async () => {
        await getSetting("domain.app");
        await getSetting("domain.app");
        expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it("never hands a read that starts after a write the answer from before it", async () => {
        let release!: () => void;
        hold = new Promise((resolve) => (release = resolve));
        const before = getSetting("domain.app");
        await setSetting("domain.app", "changed.example.test");
        hold = null;
        const after = getSetting("domain.app");
        release();
        expect(await before).toBe("polaris.example.test");
        expect(await after).toBe("changed.example.test");
        expect(findUnique).toHaveBeenCalledTimes(2);
    });

    it("shares a group read and hands each caller its own map", async () => {
        rows.set("domain.sharing", "share.example.test");
        const [a, b] = await Promise.all([
            getSettings(["domain.app", "domain.sharing"]),
            getSettings(["domain.sharing", "domain.app"])
        ]);
        expect(findMany).toHaveBeenCalledTimes(1);
        expect(a).not.toBe(b);
        a.delete("domain.app");
        expect(b.get("domain.app")).toBe("polaris.example.test");
    });
});
