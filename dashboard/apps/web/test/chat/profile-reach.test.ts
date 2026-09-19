/**
 * Who may be shown somebody's profile beside a conversation.
 *
 * The bug this pins: the panel used to ask the discoverable setting, which
 * answers a different question. Discoverable is who may FIND you when they go
 * looking; somebody already in a direct message with you has not looked you up,
 * they are talking to you. So an account set to "friends" appeared beside its own
 * conversation with no handle and nothing written about it - which reads as a
 * profile that failed to load, not as a setting doing its job.
 *
 * What replaced it has to hold in both directions, and both are asserted here: a
 * person in the conversation is shown whatever their discoverable setting says,
 * and an id that names somebody who is not in it is refused - otherwise the
 * action is a directory of everybody on the instance, which is the thing the
 * discoverable check was standing in for.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const ACCOUNTS = [
    {
        id: "grace",
        name: "grace",
        firstName: "Grace",
        lastName: "Hopper",
        username: "grace",
        description: "Compilers.",
        bannedAt: null
    },
    {
        id: "alan",
        name: "Alan Turing",
        firstName: null,
        lastName: null,
        username: "alan",
        description: "",
        bannedAt: null
    },
    {
        id: "banned",
        name: "Somebody",
        firstName: null,
        lastName: null,
        username: "somebody",
        description: "",
        bannedAt: new Date()
    }
];

/** Who is in the one conversation these tests are about. */
let members = new Set(["ada", "grace", "banned"]);
/** Who has blocked whom, as the service answers it. */
let blocked = new Set<string>();
/** Whose name on the account may be read by the person asking. Nobody's, until
 *  a test says otherwise - which is the default every account is on. */
let namesOpen = new Set<string>();

vi.mock("@/lib/privacy-service", () => ({
    maySee: async (subjectId: string) => namesOpen.has(subjectId)
}));

vi.mock("@/lib/blocks", () => ({
    blockedBetween: async (_viewerId: string, userIds: readonly string[]) =>
        new Set(userIds.filter((id) => blocked.has(id)))
}));

// The rule for "is this person in this conversation", mocked at the same seam
// the service reads it through - so what is asserted here is which question is
// asked, not a second copy of how membership is worked out.
// What the two of them have in common. Its own module and its own test; here it
// is stubbed empty, so what this file asserts stays "who may be shown to whom"
// rather than quietly also testing the intersection.
vi.mock("@/lib/mutuals", () => ({
    mutualsBetween: async () => ({
        friends: { people: [], total: 0 },
        spaces: { spaces: [], total: 0 }
    })
}));

vi.mock("@/lib/chat/access", () => ({
    channelAccess: async (actor: { id: string }, channelId: string) => {
        if (!members.has(actor.id)) return null;
        const room = { channelId, member: true, mayModerate: false };
        if (channelId === "d1") return { ...room, spaceId: null, kind: "dm" };
        // A group whose owner is grace, and a channel in a space.
        if (channelId === "g1")
            return { ...room, spaceId: null, kind: "group", mayModerate: actor.id === "grace" };
        if (channelId === "s1") return { ...room, spaceId: "space", kind: "text" };
        return null;
    }
}));

/** Who owns the one space, and who administers it. */
let spaceOwner = "grace";
let spaceAdmins = new Set<string>();

vi.mock("@polaris/db", () => ({
    // The filter every screen hides a suspended or switched-off account with.
    // A constant rather than a stub: it is the real value, and a test that
    // invented its own would be checking a different rule than the code runs.
    VISIBLE_USER: { bannedAt: null, disabledAt: null },
    prisma: {
        user: {
            findFirst: async ({ where }: { where: { id: string; bannedAt: null } }) =>
                ACCOUNTS.find((person) => person.id === where.id && person.bannedAt === null) ?? null
        },
        chatSpace: {
            findUnique: async () => ({ ownerId: spaceOwner })
        },
        chatSpaceMember: {
            findUnique: async ({ where }: { where: { spaceId_userId: { userId: string } } }) => ({
                role: spaceAdmins.has(where.spaceId_userId.userId) ? "admin" : "member"
            })
        }
    }
}));

const { chatProfile } = await import("@/lib/chat/profiles");

beforeEach(() => {
    members = new Set(["ada", "grace", "banned"]);
    blocked = new Set();
    namesOpen = new Set();
    spaceOwner = "grace";
    spaceAdmins = new Set();
});

describe("somebody in the conversation", () => {
    it("is shown whatever they keep out of a search", async () => {
        const profile = await chatProfile({ id: "ada" }, "d1", "grace");
        expect(profile?.username).toBe("grace");
        expect(profile?.description).toBe("Compilers.");
    });

    it("is drawn by the name they chose to show, and not by the one behind it", async () => {
        // The whole reason an account has both. The display name is what every
        // screen draws; the name on the account is an ordinary personal detail
        // and starts shut, so being in a conversation with somebody hands it
        // over to nobody.
        const profile = await chatProfile({ id: "ada" }, "d1", "grace");
        expect(profile?.name).toBe("grace");
        expect(profile?.fullName).toBe("");
    });

    it("has their name put back together for a reader they allow", async () => {
        namesOpen = new Set(["grace"]);
        const profile = await chatProfile({ id: "ada" }, "d1", "grace");
        expect(profile?.fullName).toBe("Grace Hopper");
    });

    it("has no name to show when they have not given one", async () => {
        members.add("alan");
        namesOpen = new Set(["alan"]);
        const profile = await chatProfile({ id: "ada" }, "d1", "alan");
        expect(profile?.fullName).toBe("");
    });
});

describe("everybody else", () => {
    it("refuses an id that is not in the conversation", async () => {
        expect(await chatProfile({ id: "ada" }, "d1", "alan")).toBeNull();
    });

    it("refuses a reader who is not in it either, whoever they ask about", async () => {
        expect(await chatProfile({ id: "eve" }, "d1", "grace")).toBeNull();
    });

    it("refuses a conversation that does not exist", async () => {
        expect(await chatProfile({ id: "ada" }, "nowhere", "grace")).toBeNull();
    });

    it("refuses a block in either direction, with the same answer", async () => {
        blocked = new Set(["grace"]);
        expect(await chatProfile({ id: "ada" }, "d1", "grace")).toBeNull();
    });

    it("refuses a suspended account", async () => {
        expect(await chatProfile({ id: "ada" }, "d1", "banned")).toBeNull();
    });
});

describe("your own", () => {
    it("is shown to you, name and all, with nothing in common with yourself", async () => {
        // What pressing your own name shows: what everybody else is shown, plus
        // the name on your account, which is yours to see.
        const profile = await chatProfile({ id: "grace" }, "d1", "grace");
        expect(profile?.username).toBe("grace");
        expect(profile?.fullName).toBe("Grace Hopper");
        expect(profile?.mutual.friends.total).toBe(0);
        expect(profile?.mutual.spaces.total).toBe(0);
    });

    it("is still asked inside a conversation you are in", async () => {
        expect(await chatProfile({ id: "grace" }, "nowhere", "grace")).toBeNull();
    });
});

describe("what somebody is in the place it was asked from", () => {
    it("is nothing in a direct message", async () => {
        expect((await chatProfile({ id: "ada" }, "d1", "grace"))?.role).toBeNull();
    });

    it("is the owner of a group they own, and nothing for everybody else in it", async () => {
        members.add("alan");
        expect((await chatProfile({ id: "ada" }, "g1", "grace"))?.role).toBe("owner");
        expect((await chatProfile({ id: "grace" }, "g1", "alan"))?.role).toBeNull();
    });

    it("is the space's owner or one of its admins, as the roster says", async () => {
        members.add("alan");
        spaceAdmins = new Set(["alan"]);
        expect((await chatProfile({ id: "ada" }, "s1", "grace"))?.role).toBe("owner");
        expect((await chatProfile({ id: "grace" }, "s1", "alan"))?.role).toBe("admin");
        spaceAdmins = new Set();
        expect((await chatProfile({ id: "grace" }, "s1", "alan"))?.role).toBeNull();
    });
});
