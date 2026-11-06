/**
 * The list's last-message read has to run on Postgres, not just in a mock.
 *
 * Prisma binds a JS number as a bigint, and `left(text, bigint)` does not
 * exist: the uncast preview length failed the whole read in production, the
 * failure was swallowed, and every detailed row drew a name with nothing under
 * it - no message, no time, no ticks. Every number in the statement is cast.
 */

import { describe, expect, it, vi } from "vitest";

const queryRaw = vi.fn().mockResolvedValue([]);
vi.mock("@polaris/db", () => ({ prisma: { $queryRaw: queryRaw } }));

const { lastMessages } = await import("@/lib/chat/last-messages");

describe("the last-message statement", () => {
    it("casts every number it binds", async () => {
        await lastMessages(["c1"]);
        const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
        const numbers = values.flatMap((value, at) => (typeof value === "number" ? [at] : []));
        expect(numbers.length).toBeGreaterThan(0);
        for (const at of numbers) expect(strings[at + 1]).toMatch(/^::int\b/);
    });

    it("binds the conversations as a uuid array", async () => {
        queryRaw.mockClear();
        await lastMessages(["c1", "c2"]);
        const [strings, ...values] = queryRaw.mock.calls[0] as [TemplateStringsArray, ...unknown[]];
        const at = values.findIndex(Array.isArray);
        expect(values[at]).toEqual(["c1", "c2"]);
        expect(strings[at + 1]).toMatch(/^::uuid\[\]/);
    });
});
