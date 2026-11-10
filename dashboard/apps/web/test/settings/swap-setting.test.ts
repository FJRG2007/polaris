/**
 * Claiming a setting that is not set yet, on either database.
 *
 * The first writer wins and the second is told no; any other failure is not a
 * lost race and is not swallowed as one.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let rows = new Map<string, string>();
let failWith: Error | null = null;

vi.mock("@polaris/db", () => ({
    prisma: {
        setting: {
            create: async ({ data }: { data: { key: string; value: string } }) => {
                if (failWith) throw failWith;
                if (rows.has(data.key)) throw Object.assign(new Error("unique"), { code: "P2002" });
                rows.set(data.key, data.value);
                return { key: data.key };
            }
        }
    }
}));

const { swapSetting } = await import("@/lib/setting-store");

beforeEach(() => {
    rows = new Map();
    failWith = null;
});

describe("swapSetting from unset", () => {
    it("lets the first claim through and refuses the second", async () => {
        expect(await swapSetting("mark", null, "a")).toBe(true);
        expect(await swapSetting("mark", null, "b")).toBe(false);
        expect(rows.get("mark")).toBe("a");
    });

    it("does not read a broken database as a lost race", async () => {
        failWith = new Error("database is locked");
        await expect(swapSetting("mark", null, "a")).rejects.toThrow("database is locked");
    });
});
