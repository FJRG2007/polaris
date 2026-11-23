/**
 * A profile read by somebody outside its audience.
 *
 * Asserted on what the server hands back rather than on what a screen draws,
 * because the screen is not where it is enforced: the profile page and the
 * card beside a conversation both get the name, the handle and the photo as the
 * photo setting allows, and nothing the person wrote, links to or shares.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** Which fields the subject lets this reader see. */
let allowed = new Set<string>();

const person = {
    id: "subject",
    name: "Fixture Person",
    username: "fixture.person",
    firstName: "Fixture",
    lastName: "Surname",
    email: "fixture@example.test",
    company: "Fixture Co",
    profileCompanies: null,
    description: "fixture bio",
    headline: "fixture headline",
    pronouns: "they/them",
    links: JSON.stringify([{ url: "https://example.test/fixture", label: "" }]),
    profileOrgIds: null,
    bannedAt: null,
    createdAt: new Date("2026-01-01T00:00:00Z")
};

const mutualsBetween = vi.fn(async () => ({
    friends: { people: [{ id: "f", name: "Fixture Friend", username: "f" }], total: 1 },
    spaces: { spaces: [{ id: "s", name: "Fixture Space", color: "#000" }], total: 1 }
}));

const RECENT = [{ key: "r", source: "game", name: "Fixture Game", details: "", imageUrl: null, gameId: null, endedAt: "2026-11-20T10:00:00.000Z" }];
const recentActivityFor = vi.fn(async () => RECENT);
let publicSetting: string | null = null;
let friendship: { status: string; createdAt: Date; respondedAt: Date | null } | null = null;

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: {
        user: { findUnique: async () => person, findFirst: async () => person },
        friendship: { findFirst: async () => friendship },
        userPrivacy: {
            findUnique: async () =>
                Object.fromEntries(
                    ["discoverable", "profile", "avatar", "fullName", "email", "companies", "followers"].map(
                        (field) => [field, "everyone"]
                    )
                )
        },
        organization: { findMany: async () => [] },
        chatSpace: { findUnique: async () => ({ ownerId: "someone-else" }) },
        chatSpaceMember: { findUnique: async () => ({ role: "member" }) }
    }
}));
vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async (_viewer: unknown, field: string, ids: string[]) =>
        new Set(allowed.has(field) ? ids : []),
    maySee: async (_subject: string, field: string) => allowed.has(field),
    defaultFollowerAudience: async () => "everyone",
    privacyDefaults: async () => new Map(),
    privacyLocks: async () => new Set()
}));
vi.mock("@/lib/mutuals", () => ({ mutualsBetween }));
vi.mock("@/lib/presence-activity/recent", () => ({ recentActivityFor }));
vi.mock("@/lib/badges/badge-service", () => ({ badgesBesideName: async () => [] }));
vi.mock("@/lib/friends-service", () => ({ areFriends: async () => false }));
vi.mock("@/lib/blocks", () => ({
    blockedBy: async () => new Set(),
    blockersOf: async () => new Set(),
    blockedBetween: async () => new Set()
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => publicSetting,
    setSetting: async () => {}
}));
vi.mock("@/lib/profile-style-service", () => ({ getProfileStyle: async () => ({}) }));
vi.mock("@/lib/people-follow", () => ({
    followCounts: async () => ({ followers: 3, following: 4 }),
    followsPerson: async () => false
}));
vi.mock("@/lib/chat/access", () => ({
    channelAccess: async () => ({ spaceId: "space", kind: "text", mayModerate: false })
}));

const { publicProfile } = await import("@/lib/profile-service");
const { chatProfile } = await import("@/lib/chat/profiles");

const reader = { id: "reader", isAdmin: false };
const OPEN = ["discoverable", "profile", "avatar", "fullName", "email", "companies", "followers"];

beforeEach(() => {
    allowed = new Set(OPEN);
    mutualsBetween.mockClear();
    recentActivityFor.mockClear();
    friendship = null;
    publicSetting = null;
});

describe("the profile page", () => {
    it("is whole for a reader inside the audience", async () => {
        const profile = await publicProfile(person.username, reader);
        expect(profile).toMatchObject({
            restricted: false,
            description: person.description,
            headline: person.headline,
            pronouns: person.pronouns,
            email: person.email
        });
        expect(profile?.links).toHaveLength(1);
        expect(profile?.mutual).not.toBeNull();
    });

    it("is the name and the photo for a reader outside it", async () => {
        allowed.delete("profile");
        const profile = await publicProfile(person.username, reader);
        expect(profile).toMatchObject({
            restricted: true,
            name: person.name,
            username: person.username,
            showsAvatar: true,
            description: "",
            headline: "",
            pronouns: "",
            fullName: "",
            email: "",
            joinedAt: "",
            companies: [],
            organizations: [],
            links: [],
            mutual: null,
            follows: { followers: 0, following: 0, showsNames: false }
        });
        expect(mutualsBetween).not.toHaveBeenCalled();
    });

    it("carries what they did lately and since when you are friends, as the chat profile does", async () => {
        friendship = {
            status: "accepted",
            createdAt: new Date("2024-05-01T00:00:00Z"),
            respondedAt: new Date("2024-06-01T00:00:00Z")
        };
        const profile = await publicProfile(person.username, { id: reader.id, isAdmin: true });
        expect(profile?.recent).toEqual(RECENT);
        expect(profile?.friendsSince).toBe("2024-06-01T00:00:00.000Z");
        // Never as an administrator: the activity audience is the owner's.
        expect(recentActivityFor).toHaveBeenCalledWith({ id: reader.id, isAdmin: false }, person.id);
    });

    it("tells a reader with no account nothing they did and no friendship", async () => {
        // An instance that publishes profiles to readers with no account.
        publicSetting = "true";
        const profile = await publicProfile(person.username, null);
        expect(profile?.recent).toEqual([]);
        expect(profile?.friendsSince).toBe("");
        expect(recentActivityFor).not.toHaveBeenCalled();
    });

    it("tells a reader outside the audience nothing they did lately", async () => {
        allowed.delete("profile");
        friendship = { status: "accepted", createdAt: new Date(), respondedAt: null };
        const profile = await publicProfile(person.username, reader);
        expect(profile).toMatchObject({ recent: [], friendsSince: "" });
        expect(recentActivityFor).not.toHaveBeenCalled();
    });

    it("still follows the photo setting on the restricted card", async () => {
        allowed.delete("profile");
        allowed.delete("avatar");
        expect((await publicProfile(person.username, reader))?.showsAvatar).toBe(false);
    });

    it("is whole for its owner whatever the setting", async () => {
        allowed.delete("profile");
        const profile = await publicProfile(person.username, { id: person.id, isAdmin: false });
        expect(profile?.restricted).toBe(false);
        expect(profile?.description).toBe(person.description);
    });
});

describe("the card beside a conversation", () => {
    it("is whole for a reader inside the audience", async () => {
        const profile = await chatProfile({ id: reader.id } as never, "channel", person.id);
        expect(profile).toMatchObject({ restricted: false, description: person.description });
        expect(profile?.mutual.friends.total).toBe(1);
    });

    it("is the name, the handle and the role for a reader outside it", async () => {
        allowed.delete("profile");
        const profile = await chatProfile({ id: reader.id } as never, "channel", person.id);
        expect(profile).toMatchObject({
            restricted: true,
            name: person.name,
            username: person.username,
            fullName: "",
            description: "",
            headline: "",
            pronouns: "",
            mutual: { friends: { people: [], total: 0 }, spaces: { spaces: [], total: 0 } }
        });
        expect(mutualsBetween).not.toHaveBeenCalled();
    });
});
