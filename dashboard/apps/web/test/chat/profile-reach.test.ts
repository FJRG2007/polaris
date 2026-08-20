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

vi.mock("@/lib/blocks", () => ({
    blockedBetween: async (_viewerId: string, userIds: readonly string[]) =>
        new Set(userIds.filter((id) => blocked.has(id)))
}));

// The rule for "is this person in this conversation", mocked at the same seam
// the service reads it through - so what is asserted here is which question is
// asked, not a second copy of how membership is worked out.
vi.mock("@/lib/chat/access", () => ({
    channelAccess: async (actor: { id: string }, channelId: string) =>
        channelId === "d1" && members.has(actor.id) ? { channelId, member: true } : null
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findFirst: async ({ where }: { where: { id: string; bannedAt: null } }) =>
                ACCOUNTS.find((person) => person.id === where.id && person.bannedAt === null) ?? null
        }
    }
}));

const { chatProfile } = await import("@/lib/chat/profiles");

beforeEach(() => {
    members = new Set(["ada", "grace", "banned"]);
    blocked = new Set();
});

describe("somebody in the conversation", () => {
    it("is shown whatever they keep out of a search", async () => {
        const profile = await chatProfile({ id: "ada" }, "d1", "grace");
        expect(profile?.username).toBe("grace");
        expect(profile?.description).toBe("Compilers.");
    });

    it("has their name put back together from both halves", async () => {
        const profile = await chatProfile({ id: "ada" }, "d1", "grace");
        // What they are called on screen, and the name behind it - two different
        // things, and the panel draws the second only when it says something the
        // first does not.
        expect(profile?.name).toBe("grace");
        expect(profile?.fullName).toBe("Grace Hopper");
    });

    it("has no name to show when they have not given one", async () => {
        members.add("alan");
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

    it("refuses a suspended account, and your own id", async () => {
        expect(await chatProfile({ id: "ada" }, "d1", "banned")).toBeNull();
        expect(await chatProfile({ id: "grace" }, "d1", "grace")).toBeNull();
    });
});
