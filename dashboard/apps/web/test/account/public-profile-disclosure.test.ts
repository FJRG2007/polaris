/**
 * What a public profile hands out, and to whom.
 *
 * Two rules, both of which were wrong on the page as first shipped and both of
 * which are silent when they break - the failure is a field appearing where
 * nobody expected it, on somebody else's screen.
 *
 * **Running Polaris is not a reason to be shown a different profile.** The
 * privacy layer lets an administrator through everything, deliberately and as a
 * stated fact: whoever runs the instance can read the database. But this page is
 * headed "what everybody sees", so an administrator following a link to a
 * colleague was shown that colleague's private address under a heading saying it
 * was public - with no way to tell, from the page, which parts of it anybody else
 * could actually read. Chat already resolves this the same way; the profile now
 * does too, and /admin/users remains where reading more than an account
 * publishes is what the screen is for.
 *
 * **The counts are not the names.** How many people follow somebody is a fact
 * about them and belongs on their page; who those people are is a fact about
 * several others who never chose to appear on it. One setting used to hide both,
 * which took away the part a profile is expected to carry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The account being looked at. */
const SUBJECT = {
    id: "018f2b7a-0000-7000-8000-0000000000aa",
    name: "Ada Lovelace",
    username: "ada",
    firstName: "Ada",
    lastName: "Lovelace",
    email: "ada@example.test",
    company: null,
    profileCompanies: null,
    description: "",
    headline: "",
    pronouns: "",
    links: null,
    profileOrgIds: null,
    bannedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z")
};

/** Every viewer the privacy layer was asked about, in order. */
const asked: { id: string; isAdmin: boolean }[] = [];
/** What the settings say, per field. Everything is shut unless a test opens it. */
let open: Record<string, boolean> = {};

vi.mock("@polaris/db", () => ({
    prisma: {
        user: { findUnique: async () => SUBJECT, findMany: async () => [] },
        organization: { findMany: async () => [] },
        // A reader with no session is answered from the stored row rather than
        // through the audience layer, so there has to be one to read.
        userPrivacy: { findUnique: async () => null },
        friendship: { findFirst: async () => null }
    }
}));

vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async (
        viewer: { id: string; isAdmin: boolean },
        field: string,
        ids: readonly string[]
    ) => {
        asked.push(viewer);
        return new Set(open[field] ? ids : []);
    },
    maySee: async (_id: string, _field: string, viewer: { id: string; isAdmin: boolean }) => {
        asked.push(viewer);
        return false;
    },
    defaultFollowerAudience: async () => "nobody"
}));

vi.mock("@/lib/blocks", () => ({
    blockedBy: async () => new Set<string>(),
    blockersOf: async () => new Set<string>()
}));
vi.mock("@/lib/friends-service", () => ({ areFriends: async () => false }));
vi.mock("@/lib/mutuals", () => ({
    mutualsBetween: async () => ({
        friends: { people: [], total: 0 },
        spaces: { spaces: [], total: 0 }
    })
}));
vi.mock("@/lib/people-follow", () => ({
    followCounts: async () => ({ followers: 12, following: 3 }),
    followsPerson: async () => false
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => "true",
    setSetting: async () => undefined
}));

const { publicProfile } = await import("@/lib/profile-service");

/** An administrator, arriving the way a session hands one over. */
const ADMIN = { id: "018f2b7a-0000-7000-8000-0000000000bb", isAdmin: true };

describe("an administrator on somebody's public page", () => {
    beforeEach(() => {
        asked.length = 0;
        open = { discoverable: true };
    });

    it("is never handed to the privacy layer as an administrator", async () => {
        await publicProfile("ada", ADMIN);
        expect(asked.length).toBeGreaterThan(0);
        expect(asked.every((viewer) => viewer.isAdmin === false)).toBe(true);
    });

    it("keeps their own identity, so their own friendships still count", async () => {
        await publicProfile("ada", ADMIN);
        expect(asked.every((viewer) => viewer.id === ADMIN.id)).toBe(true);
    });

    it("does not print an address the account keeps to itself", async () => {
        const profile = await publicProfile("ada", ADMIN);
        expect(profile?.email).toBe("");
    });

    it("still prints one the account publishes", async () => {
        open = { discoverable: true, email: true };
        const profile = await publicProfile("ada", ADMIN);
        expect(profile?.email).toBe(SUBJECT.email);
    });

    it("is turned away by an account that keeps itself out of being found", async () => {
        open = {};
        expect(await publicProfile("ada", ADMIN)).toBeNull();
    });
});

describe("follower counts and follower names", () => {
    beforeEach(() => {
        asked.length = 0;
        open = { discoverable: true };
    });

    it("shows the numbers to a reader who may not open either list", async () => {
        const profile = await publicProfile("ada", { id: "reader", isAdmin: false });
        expect(profile?.follows.followers).toBe(12);
        expect(profile?.follows.following).toBe(3);
        expect(profile?.follows.showsNames).toBe(false);
    });

    it("opens the names where the setting says so", async () => {
        open = { discoverable: true, followers: true };
        const profile = await publicProfile("ada", { id: "reader", isAdmin: false });
        expect(profile?.follows.showsNames).toBe(true);
    });

    it("shows the numbers to a reader with no account at all", async () => {
        const profile = await publicProfile("ada", null);
        expect(profile?.follows.followers).toBe(12);
        expect(profile?.follows.showsNames).toBe(false);
    });
});
