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

vi.mock("@polaris/db", () => ({
    VISIBLE_USER: {},
    prisma: {
        user: { findUnique: async () => person, findFirst: async () => person },
        friendship: { findFirst: async () => null },
        organization: { findMany: async () => [] },
        chatSpace: { findUnique: async () => ({ ownerId: "someone-else" }) },
        chatSpaceMember: { findUnique: async () => ({ role: "member" }) }
    }
}));
vi.mock("@/lib/privacy-service", () => ({
    allowedBy: async (_viewer: unknown, field: string, ids: string[]) =>
        new Set(allowed.has(field) ? ids : []),
    maySee: async (_subject: string, field: string) => allowed.has(field),
    defaultFollowerAudience: async () => "everyone"
}));
vi.mock("@/lib/mutuals", () => ({ mutualsBetween }));
vi.mock("@/lib/friends-service", () => ({ areFriends: async () => false }));
vi.mock("@/lib/blocks", () => ({
    blockedBy: async () => new Set(),
    blockersOf: async () => new Set(),
    blockedBetween: async () => new Set()
}));
vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => null,
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
