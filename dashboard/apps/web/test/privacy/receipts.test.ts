/**
 * Whether ticks may be drawn between two people.
 *
 * This is the reciprocal one. Somebody who turns their read receipts off stops
 * seeing everybody else's, and the failure worth testing for is the version that
 * still works one way: their ticks hidden, everybody else's still visible to
 * them. That is a mirror rather than a setting, and it is the shape a naive
 * implementation lands on because each side reads only the other's row.
 *
 * The audiences that name people are tested here too, for the same reason: "on
 * for her, off for everybody else" is the setting people actually want, and it
 * has to stay reciprocal - somebody who leaves you off their list does not get
 * to see your ticks either.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Each account's read-receipt audience, by id. */
let settings = new Map<string, string>();
/** The list one account's read-receipt rule names, and who is on it. */
let lists = new Map<string, { listId: string; members: string[] }>();
let friends = false;

vi.mock("@polaris/db", () => ({
    prisma: {
        userPrivacy: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((userId) => settings.has(userId))
                    .map((userId) => ({
                        userId,
                        avatar: "everyone",
                        email: "nobody",
                        phone: "nobody",
                        lastSeen: "everyone",
                        forwarding: "everyone",
                        discoverable: "everyone",
                        readReceipts: settings.get(userId)
                    }))
        },
        privacyFieldList: {
            findMany: async ({ where }: { where: { field: string; userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((userId) => lists.has(userId))
                    .map((userId) => ({ userId, listId: lists.get(userId)!.listId }))
        },
        privacyListMember: {
            findMany: async ({ where }: { where: { userId: string; listId: { in: string[] } } }) =>
                [...lists.values()]
                    .filter(
                        (list) =>
                            where.listId.in.includes(list.listId) &&
                            list.members.includes(where.userId)
                    )
                    .map((list) => ({ listId: list.listId }))
        }
    }
}));

vi.mock("@/lib/friends-service", () => ({
    friendIds: async () => (friends ? new Set(["ada", "grace"]) : new Set<string>())
}));

const { receiptsBetween } = await import("@/lib/privacy-service");

const ada = { id: "ada", isAdmin: false };

beforeEach(() => {
    settings = new Map();
    lists = new Map();
    friends = false;
});

describe("two accounts that have changed nothing", () => {
    it("see each other's ticks", async () => {
        expect(await receiptsBetween(ada, "grace")).toBe(true);
    });
});

describe("turning your own off", () => {
    it("stops you seeing theirs", async () => {
        // The whole point. Hiding yours is not a way to keep watching.
        settings.set("ada", "nobody");
        expect(await receiptsBetween(ada, "grace")).toBe(false);
    });
});

describe("the other person turning theirs off", () => {
    it("stops you seeing theirs", async () => {
        settings.set("grace", "nobody");
        expect(await receiptsBetween(ada, "grace")).toBe(false);
    });
});

describe("friends only", () => {
    it("shows them between friends", async () => {
        settings.set("ada", "friends");
        settings.set("grace", "friends");
        friends = true;
        expect(await receiptsBetween(ada, "grace")).toBe(true);
    });

    it("hides them between strangers", async () => {
        settings.set("grace", "friends");
        friends = false;
        expect(await receiptsBetween(ada, "grace")).toBe(false);
    });

    it("is enough for one side to say it", async () => {
        // One "friends" and one "everyone" is still a question about friendship,
        // because the stricter of the two is what the pair is under.
        settings.set("ada", "friends");
        friends = false;
        expect(await receiptsBetween(ada, "grace")).toBe(false);
    });
});

describe("only these people", () => {
    it("shows them to somebody on the list", async () => {
        // The setting this feature exists for: ticks on for one conversation and
        // off everywhere else.
        settings.set("ada", "only");
        lists.set("ada", { listId: "ada-list", members: ["grace"] });
        expect(await receiptsBetween(ada, "grace")).toBe(true);
    });

    it("hides them from somebody who is not", async () => {
        settings.set("ada", "only");
        lists.set("ada", { listId: "ada-list", members: ["hopper"] });
        expect(await receiptsBetween(ada, "grace")).toBe(false);
    });

    it("stays reciprocal when the other side leaves you off theirs", async () => {
        settings.set("ada", "everyone");
        settings.set("grace", "only");
        lists.set("grace", { listId: "grace-list", members: ["hopper"] });
        expect(await receiptsBetween(ada, "grace")).toBe(false);
    });

    it("shows nobody anything when the list it names has gone", async () => {
        // A rule pointing at nothing must close rather than open: losing a list
        // is not a decision to show everybody.
        settings.set("ada", "only");
        expect(await receiptsBetween(ada, "grace")).toBe(false);
    });
});

describe("everybody except", () => {
    it("hides them from the one person named", async () => {
        settings.set("ada", "everyoneExcept");
        lists.set("ada", { listId: "ada-list", members: ["grace"] });
        expect(await receiptsBetween(ada, "grace")).toBe(false);
    });

    it("shows them to everybody else", async () => {
        settings.set("ada", "everyoneExcept");
        lists.set("ada", { listId: "ada-list", members: ["hopper"] });
        expect(await receiptsBetween(ada, "grace")).toBe(true);
    });
});

describe("an administrator", () => {
    it("sees them whatever either side chose", async () => {
        settings.set("ada", "nobody");
        settings.set("grace", "nobody");
        expect(await receiptsBetween({ id: "root", isAdmin: true }, "grace")).toBe(true);
    });
});
