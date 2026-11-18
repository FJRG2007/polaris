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
        privacyFieldList: {
            findMany: async () => [],
            findUnique: async ({ where }: { where: { userId_field: { userId: string } } }) =>
                where.userId_field.userId === "me" && listMembers.length > 0
                    ? { listId: "list-1" }
                    : null
        },
        privacyListMember: {
            findMany: async ({ where }: { where: { userId: string | { in: string[] } } }) =>
                typeof where.userId === "object"
                    ? listMembers
                          .filter((userId) =>
                              (where.userId as { in: string[] }).in.includes(userId)
                          )
                          .map((userId) => ({ userId }))
                    : []
        },
        follow: { findMany: async () => [] },
        friendship: { findMany: async () => [] }
    }
}));

/** Who the viewer's own list names, and who their friends are. */
let listMembers: string[] = [];
let friendsOf = new Map<string, string[]>();
const friendIds = vi.fn(async (userId: string) => new Set(friendsOf.get(userId) ?? []));

vi.mock("@/lib/friends-service", () => ({ friendIds: (userId: string) => friendIds(userId) }));

const { receiptsAmong, typingAllowed } = await import("@/lib/privacy-service");

const viewer = { id: "me", isAdmin: false };

beforeEach(() => {
    stored = new Map();
    listMembers = [];
    friendsOf = new Map();
    findUnique.mockClear();
    friendIds.mockClear();
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

    it("settles a friends-only viewer from one read of their friends, not one per row", async () => {
        stored = new Map([
            ["me", "friends"],
            ["a", "everyone"],
            ["b", "everyone"],
            ["c", "everyone"]
        ]);
        friendsOf = new Map([["me", ["a", "c"]]]);
        expect(await receiptsAmong(viewer, ["a", "b", "c"])).toEqual(new Set(["a", "c"]));
        expect(friendIds).toHaveBeenCalledTimes(1);
        expect(friendIds).toHaveBeenCalledWith("me");
    });

    it("reads the viewer's own list once for an audience that names people", async () => {
        stored = new Map([
            ["me", "only"],
            ["a", "everyone"],
            ["b", "everyone"]
        ]);
        listMembers = ["b"];
        expect(await receiptsAmong(viewer, ["a", "b"])).toEqual(new Set(["b"]));
    });

    it("lets an administrator see them all", async () => {
        expect(await receiptsAmong({ id: "me", isAdmin: true }, ["a", "b"])).toEqual(
            new Set(["a", "b"])
        );
    });
});

describe("a conversation's own rule", () => {
    it("on: shows everybody's ticks even to a viewer whose account says nobody", async () => {
        stored = new Map([
            ["me", "nobody"],
            ["a", "nobody"]
        ]);
        expect(await receiptsAmong(viewer, ["a", "b"], "on")).toEqual(new Set(["a", "b"]));
        expect(findUnique).not.toHaveBeenCalled();
    });

    it("off: shows nobody's even when both accounts allow them", async () => {
        stored = new Map([
            ["me", "everyone"],
            ["a", "everyone"]
        ]);
        expect(await receiptsAmong(viewer, ["a"], "off")).toEqual(new Set());
    });

    it("follow: the accounts decide, as before", async () => {
        stored = new Map([
            ["me", "nobody"],
            ["a", "everyone"]
        ]);
        expect(await receiptsAmong(viewer, ["a"], "follow")).toEqual(new Set());
    });

    it("typing: on shows it, off hides it from everybody, an administrator included", async () => {
        expect(await typingAllowed(viewer, "a", "on")).toBe(true);
        expect(await typingAllowed(viewer, "a", "off")).toBe(false);
        expect(await typingAllowed({ id: "admin", isAdmin: true }, "a", "off")).toBe(false);
        expect(await typingAllowed({ id: "admin", isAdmin: true }, "a", "follow")).toBe(true);
        // Your own dots are yours whatever the chat says.
        expect(await typingAllowed(viewer, "me", "off")).toBe(true);
    });
});
