/**
 * What a list of people may print under somebody's name.
 *
 * One function answers it for every roster, member list and share dialog, so it
 * is the one place an address can leak from - and the failure that matters is
 * the silent one: an account that has never opened the privacy screen has no row
 * at all, which is the state almost every account on an instance is in. If
 * absence resolves to "everyone" here, the setting is shut on the screen and
 * open everywhere it counts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** What each account has stored for `email`, by id. Absent means no row. */
let stored = new Map<string, string>();
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
                        lastSeen: "everyone",
                        forwarding: "everyone",
                        discoverable: "everyone",
                        readReceipts: "everyone",
                        email: stored.get(userId)
                    }))
        },
        privacyFieldList: { findMany: async () => [] },
        privacyListMember: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/friends-service", () => ({ friendIds: async () => friends }));

const { contactLines } = await import("@/lib/privacy-service");

const ada = { id: "ada", isAdmin: false };
const grace = { id: "grace", name: "Grace", email: "grace@example.com", username: "grace" };

beforeEach(() => {
    stored = new Map();
    friends = new Set();
});

describe("an account that has never touched the setting", () => {
    it("keeps its address, and is named by its handle", async () => {
        // The regression: no row is not "no preference", it is the default - and
        // the default for an address is nobody.
        const lines = await contactLines(ada, [grace]);
        expect(lines.get("grace")).toBe("@grace");
    });
});

describe("an account that opened it", () => {
    it("shows the address when it says everybody", async () => {
        stored.set("grace", "everyone");
        expect((await contactLines(ada, [grace])).get("grace")).toBe("grace@example.com");
    });

    it("shows it to a friend when it says friends", async () => {
        stored.set("grace", "friends");
        friends = new Set(["grace"]);
        expect((await contactLines(ada, [grace])).get("grace")).toBe("grace@example.com");
    });

    it("withholds it from somebody who is not one", async () => {
        stored.set("grace", "friends");
        expect((await contactLines(ada, [grace])).get("grace")).toBe("@grace");
    });
});

describe("the people who see everything anyway", () => {
    it("shows an administrator the address", async () => {
        // Said on the screen too: whoever runs the instance can read the
        // database, so a setting claiming otherwise would not be true.
        expect((await contactLines({ id: "root", isAdmin: true }, [grace])).get("grace")).toBe(
            "grace@example.com"
        );
    });

    it("shows an account its own", async () => {
        expect((await contactLines({ id: "grace", isAdmin: false }, [grace])).get("grace")).toBe(
            "grace@example.com"
        );
    });
});

describe("an account with no handle either", () => {
    it("gets an empty line rather than an address", async () => {
        const anon = { id: "anon", email: "anon@example.com", username: null };
        expect((await contactLines(ada, [anon])).get("anon")).toBe("");
    });
});
