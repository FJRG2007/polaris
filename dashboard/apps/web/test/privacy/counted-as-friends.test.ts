/**
 * Counting somebody as a friend they never asked to be.
 *
 * One caller does this - a file transfer, where being put in the same
 * organization is somebody with authority over both accounts saying two people
 * work together - and it is the kind of widening that is a leak the moment it
 * is applied to the answer instead of to the question. Adding names to the set
 * `allowedBy` returned overrides every audience that names an exception:
 * "everybody except him" and "only these two" both come back refused, and both
 * would be quietly reopened.
 *
 * So it widens the FACT and the audience still decides. That is what is
 * asserted here, one audience at a time, because each of them is a different
 * sentence somebody chose on purpose.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What each account has stored for `fileTransfers`, by id. Absent means no row. */
let stored = new Map<string, string>();
/** Who is on the list the rule names, for the accounts whose rule names one. */
let listing = new Set<string>();
let friends = new Set<string>();

vi.mock("@polaris/db", () => ({
    prisma: {
        userPrivacy: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((userId) => stored.has(userId))
                    .map((userId) => ({
                        userId,
                        avatar: "everyone",
                        phone: "nobody",
                        email: "nobody",
                        lastSeen: "everyone",
                        forwarding: "everyone",
                        discoverable: "everyone",
                        readReceipts: "everyone",
                        fileTransfers: stored.get(userId)
                    }))
        },
        privacyFieldList: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((userId) => listing.has(userId))
                    .map((userId) => ({ userId, listId: `list-${userId}` }))
        },
        privacyListMember: {
            findMany: async ({ where }: { where: { listId: { in: string[] } } }) =>
                where.listId.in.map((listId) => ({ listId }))
        },
        follow: { findMany: async () => [] },
        friendship: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/friends-service", () => ({ friendIds: async () => friends }));

const { allowedBy } = await import("@/lib/privacy-service");

const sender = { id: "sender", isAdmin: false };

/** Whether the sender may offer this account a file, with it counted a
 *  colleague - which is the only way this argument is ever used. */
async function asColleague(userId: string): Promise<boolean> {
    const allowed = await allowedBy(sender, "fileTransfers", [userId], new Set([userId]));
    return allowed.has(userId);
}

beforeEach(() => {
    stored = new Map();
    listing = new Set();
    friends = new Set();
});

describe("a colleague, where the audience is answered by friendship", () => {
    it("gets in on friends, which is what the widening is for", async () => {
        stored.set("rita", "friends");
        expect(await asColleague("rita")).toBe(true);
        // And is refused without it, or there would be nothing to widen.
        expect((await allowedBy(sender, "fileTransfers", ["rita"])).has("rita")).toBe(false);
    });

    it("gets in on the default, which is friends", async () => {
        // Almost every account on an instance has never opened the screen.
        expect(await asColleague("rita")).toBe(true);
    });

    it("gets in on friends of friends, since a friend is one of those too", async () => {
        stored.set("rita", "friendsOfFriends");
        expect(await asColleague("rita")).toBe(true);
    });
});

describe("a colleague, where the audience names an exception", () => {
    it("stays out of everybody-except when it names them", async () => {
        // The regression, and the worst of them: this account allowed the whole
        // instance and then named one person. Widening the answer handed that
        // person exactly what was taken away.
        stored.set("rita", "everyoneExcept");
        listing.add("rita");
        expect(await asColleague("rita")).toBe(false);
    });

    it("stays out of friends-except when it names them", async () => {
        stored.set("rita", "friendsExcept");
        listing.add("rita");
        expect(await asColleague("rita")).toBe(false);
    });

    it("stays out of only, which names who may rather than who may not", async () => {
        stored.set("rita", "only");
        expect(await asColleague("rita")).toBe(false);
    });

    it("stays out of nobody, colleagues included", async () => {
        stored.set("rita", "nobody");
        expect(await asColleague("rita")).toBe(false);
    });
});

describe("a colleague, where the audience is not about friendship at all", () => {
    it("is not let in by following, which asks a different question", async () => {
        // "People I follow" is answered by who this account follows. Being a
        // colleague is not an answer to it, and a widening that let one through
        // would be inventing a rule nobody chose.
        stored.set("rita", "following");
        expect(await asColleague("rita")).toBe(false);
    });

    it("is not let in by followers either", async () => {
        stored.set("rita", "followers");
        expect(await asColleague("rita")).toBe(false);
    });
});

describe("without the widening", () => {
    it("changes nothing for anybody it does not name", async () => {
        stored.set("rita", "friends");
        stored.set("nadia", "friends");
        friends = new Set(["nadia"]);
        const allowed = await allowedBy(
            sender,
            "fileTransfers",
            ["rita", "nadia"],
            new Set(["rita"])
        );
        expect([...allowed].sort()).toEqual(["nadia", "rita"]);
        expect((await allowedBy(sender, "fileTransfers", ["rita", "nadia"])).has("rita")).toBe(
            false
        );
    });
});
