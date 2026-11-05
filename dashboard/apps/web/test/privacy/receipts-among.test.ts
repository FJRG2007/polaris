/**
 * Ticks for a whole conversation list at once: the same reciprocal rule as
 * `receiptsBetween`, settled without a round trip per row when the viewer's own
 * setting is "everyone" or "nobody".
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What each account has stored for `readReceipts`, by id. Absent means no row. */
let stored = new Map<string, string>();

const findUnique = vi.fn(async ({ where }: { where: { userId: string } }) =>
    stored.has(where.userId) ? { readReceipts: stored.get(where.userId) } : null
);

vi.mock("@polaris/db", () => ({
    prisma: {
        userPrivacy: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((userId) => stored.has(userId))
                    .map((userId) => ({ userId, readReceipts: stored.get(userId) })),
            findUnique
        },
        privacyFieldList: { findMany: async () => [] },
        privacyListMember: { findMany: async () => [] },
        follow: { findMany: async () => [] },
        friendship: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/friends-service", () => ({ friendIds: async () => new Set<string>() }));

const { receiptsAmong } = await import("@/lib/privacy-service");

const viewer = { id: "me", isAdmin: false };

beforeEach(() => {
    stored = new Map();
    findUnique.mockClear();
});

describe("receiptsAmong", () => {
    it("allows the people whose own setting lets the viewer see theirs", async () => {
        stored = new Map([
            ["me", "everyone"],
            ["a", "everyone"],
            ["b", "nobody"]
        ]);
        expect(await receiptsAmong(viewer, ["a", "b"])).toEqual(new Set(["a"]));
        // The viewer's own side is one read, not one per person.
        expect(findUnique).toHaveBeenCalledTimes(1);
    });

    it("allows nobody when the viewer hides their own", async () => {
        stored = new Map([
            ["me", "nobody"],
            ["a", "everyone"]
        ]);
        expect(await receiptsAmong(viewer, ["a"])).toEqual(new Set());
    });

    it("lets an administrator see them all", async () => {
        expect(await receiptsAmong({ id: "me", isAdmin: true }, ["a", "b"])).toEqual(
            new Set(["a", "b"])
        );
    });
});
