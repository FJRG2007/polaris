/**
 * Whether ticks may be drawn between two people.
 *
 * This is the reciprocal one. Somebody who turns their read receipts off stops
 * seeing everybody else's, and the failure worth testing for is the version that
 * still works one way: their ticks hidden, everybody else's still visible to
 * them. That is a mirror rather than a setting, and it is the shape a naive
 * implementation lands on because each side reads only the other's row.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Each account's setting, by id. */
let settings = new Map<string, string>();
let friends = false;

vi.mock("@polaris/db", () => ({
    prisma: {
        userPrivacy: {
            findUnique: async ({ where }: { where: { userId: string } }) => {
                const readReceipts = settings.get(where.userId);
                return readReceipts
                    ? { lastSeen: "everyone", readReceipts, avatar: "everyone" }
                    : null;
            }
        }
    }
}));

vi.mock("@/lib/friends-service", () => ({
    areFriends: async () => friends
}));

const { receiptsBetween } = await import("@/lib/privacy-service");

const ada = { id: "ada", isAdmin: false };

beforeEach(() => {
    settings = new Map();
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

describe("an administrator", () => {
    it("sees them whatever either side chose", async () => {
        settings.set("ada", "nobody");
        settings.set("grace", "nobody");
        expect(await receiptsBetween({ id: "root", isAdmin: true }, "grace")).toBe(true);
    });
});
