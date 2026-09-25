/**
 * A group chat, and what makes it different from the two things either side of
 * it.
 *
 * A channel in a space has administrators. A one-to-one conversation has nobody
 * and nothing to decide. A group is the awkward middle: it belongs to everybody
 * in it, so any of them can name it, add somebody and walk out - and none of
 * them can turn anybody else out, because a member who could do that would make
 * it a channel with an owner.
 *
 * That last rule is the one asserted hardest. Getting it wrong means somebody
 * being removed from a conversation by a peer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let kind = "group";
/** Who runs the group, and whether they have let the rest of it change how the
 *  group looks. Both default to "the owner and nobody else". */
let ownerId: string | null = "ada";
/** Who started it. Groups made before the owner column was filled in have only
 *  this, and it is the same person. */
let createdById: string | null = "ada";
let membersMayEdit = false;
/** Whether the rest of the group may add people. On unless the owner closed it,
 *  which is how every group behaved before there was a switch. */
let membersMayInvite = true;
let members = ["ada", "grace", "alan"];
let written: {
    name?: string;
    removed?: string[];
    added?: string[];
    options?: Record<string, unknown>;
    /** Channels deleted, and whose stored files were thrown away first. */
    deleted?: string[];
    filesDiscarded?: string[];
} = {};
/** Groups the sweep finds with nobody in them. */
let emptyGroups: string[] = [];

vi.mock("@/lib/chat/attachments", () => ({
    discardChannelFiles: async (ids: string[]) => {
        written.filesDiscarded = [...(written.filesDiscarded ?? []), ...ids];
    }
}));
vi.mock("@/lib/avatar-service", () => ({ discardAvatars: async () => undefined }));
vi.mock("@/lib/access/grants", () => ({ dropGrantsFor: async () => undefined }));

vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

vi.mock("@polaris/auth", () => ({
    can: async () => true
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        // Nobody has blocked anybody here; blocking has its own test.
        userBlock: { findMany: async () => [] },
        chatChannel: {
            findUnique: async () => ({
                id: "channel-1",
                spaceId: null,
                kind,
                private: true,
                archived: false,
                space: null,
                ownerId,
                createdById,
                membersMayEdit,
                membersMayInvite
            }),
            update: async ({ data }: { data: { name?: string; membersMayInvite?: boolean } }) => {
                written.name = data.name;
                written.options = data;
                return {};
            },
            findMany: async () => emptyGroups.map((id) => ({ id })),
            deleteMany: async ({ where }: { where: { id: string } }) => {
                written.deleted = [...(written.deleted ?? []), where.id];
                return { count: 1 };
            }
        },
        chatChannelMember: {
            findFirst: async () => ({ userId: members[0] ?? null }),
            // Who is already in it, which the service asks before adding so it
            // only announces the people who really are new.
            findMany: async ({ where }: { where: { userId?: { in: string[] } } }) =>
                members
                    .filter((id) => where.userId?.in?.includes(id) ?? true)
                    .map((userId) => ({ userId })),
            findUnique: async ({ where }: { where: { channelId_userId: { userId: string } } }) =>
                members.includes(where.channelId_userId.userId) ? { role: "member" } : null,
            // Two different counts are asked for: how many are in it, and how
            // many of the wanted are already among them.
            count: async ({ where }: { where?: { userId?: { in: string[] } } }) =>
                where?.userId?.in
                    ? members.filter((id) => where.userId!.in.includes(id)).length
                    : members.length,
            createMany: async ({ data }: { data: { userId: string }[] }) => {
                written.added = data.map((row) => row.userId);
                return { count: data.length };
            },
            deleteMany: async ({ where }: { where: { userId: string } }) => {
                written.removed = [...(written.removed ?? []), where.userId];
                members = members.filter((id) => id !== where.userId);
                return { count: 1 };
            }
        },
        user: { findMany: async () => [] },
        chatSpace: { findMany: async () => [] }
    }
}));

const chat = await import("@/lib/chat/chat-service");
const { ChatAccessError, invitesAllowed } = await import("@/lib/chat/access");

const ada = { id: "ada" };

beforeEach(() => {
    ownerId = "ada";
    createdById = "ada";
    membersMayEdit = false;
    membersMayInvite = true;
    kind = "group";
    members = ["ada", "grace", "alan"];
    written = {};
    emptyGroups = [];
});

describe("naming a group", () => {
    it("is the owner's", async () => {
        await chat.renameGroup(ada, "channel-1", "Weekend plans");
        // Kept as written, not slugged: a channel's name is an identifier and a
        // group's is a label somebody typed.
        expect(written.name).toBe("Weekend plans");
    });

    it("can be taken off again, putting the names back", async () => {
        await chat.renameGroup(ada, "channel-1", "");
        expect(written.name).toBe("");
    });

    it("is refused to everybody else until the owner says otherwise", async () => {
        // The default, and the reason it is the default: a group photo and a
        // group name anybody can change are a group photo and a group name that
        // change.
        ownerId = "grace";
        await expect(chat.renameGroup(ada, "channel-1", "Mine now")).rejects.toBeInstanceOf(
            ChatAccessError
        );

        membersMayEdit = true;
        await chat.renameGroup(ada, "channel-1", "Ours now");
        expect(written.name).toBe("Ours now");
    });

    it("is refused to somebody not in it", async () => {
        members = ["grace", "alan"];
        await expect(chat.renameGroup(ada, "channel-1", "Mine now")).rejects.toBeInstanceOf(
            ChatAccessError
        );
    });

    it("is still the creator's on a group that was made without an owner", async () => {
        // Groups were created with the owner column left null, so the person who
        // made one was told they were not its owner. Whoever created it is the
        // answer, and reading it that way fixes the ones already out there.
        ownerId = null;
        await chat.renameGroup(ada, "channel-1", "Mine after all");
        expect(written.name).toBe("Mine after all");
    });

    it("is still refused to somebody who neither owns nor made it", async () => {
        ownerId = null;
        createdById = "grace";
        await expect(chat.renameGroup(ada, "channel-1", "Mine now")).rejects.toBeInstanceOf(
            ChatAccessError
        );
    });

    it("is not a thing a one-to-one conversation has", async () => {
        kind = "dm";
        await expect(chat.renameGroup(ada, "channel-1", "Us two")).rejects.toThrow(/no name to set/);
    });
});

describe("adding people", () => {
    it("is anybody in the group", async () => {
        await chat.addChannelMembers(ada, "channel-1", ["turing"]);
        expect(written.added).toEqual(["turing"]);
    });

    it("stops at the size a group holds", async () => {
        members = Array.from({ length: 25 }, (_, index) => `person-${index}`).concat("ada");
        await expect(
            chat.addChannelMembers(ada, "channel-1", ["one-too-many"])
        ).rejects.toThrow(/Make a channel/);
    });
});

describe("who may add people to a group", () => {
    const grace = { id: "grace" };

    it("is everybody in it until the owner closes it", async () => {
        await chat.addChannelMembers(grace, "channel-1", ["turing"]);
        expect(written.added).toEqual(["turing"]);
    });

    it("is refused on the server to a member once the owner has closed it", async () => {
        membersMayInvite = false;
        await expect(chat.addChannelMembers(grace, "channel-1", ["turing"])).rejects.toThrow(
            /Only the owner of this group can add people/
        );
        expect(written.added).toBeUndefined();
    });

    it("stays open to the owner when it is closed", async () => {
        membersMayInvite = false;
        await chat.addChannelMembers(ada, "channel-1", ["turing"]);
        expect(written.added).toEqual(["turing"]);
    });

    it("is closed and opened by the owner alone, one switch at a time", async () => {
        await chat.setGroupOptions(ada, "channel-1", { membersMayInvite: false });
        // The other switch is left as it was rather than written back.
        expect(written.options).toEqual({ membersMayInvite: false });

        await expect(
            chat.setGroupOptions(grace, "channel-1", { membersMayInvite: true })
        ).rejects.toThrow(/Only the owner/);
    });

    it("keeps @everyone and @here open or closed by the owner alone", async () => {
        await chat.setGroupOptions(ada, "channel-1", { membersMayMention: false });
        expect(written.options).toEqual({ membersMayMention: false });

        written = {};
        await expect(
            chat.setGroupOptions(grace, "channel-1", { membersMayMention: true })
        ).rejects.toThrow(/Only the owner/);
        expect(written.options).toBeUndefined();
    });

    it("is decided the same way for the button as for the service", () => {
        const group = {
            kind: "group",
            spaceId: null,
            ownerId: "ada",
            membersMayInvite: false,
            mayAdminister: false
        };
        expect(invitesAllowed(group, "ada")).toBe(true);
        expect(invitesAllowed(group, "grace")).toBe(false);
        expect(invitesAllowed({ ...group, membersMayInvite: true }, "grace")).toBe(true);
        // A one-to-one conversation takes nobody, and a channel is its admins'.
        expect(invitesAllowed({ ...group, kind: "dm", membersMayInvite: true }, "ada")).toBe(false);
        expect(invitesAllowed({ ...group, kind: "text", spaceId: "space-1" }, "ada")).toBe(false);
        expect(
            invitesAllowed(
                { ...group, kind: "text", spaceId: "space-1", mayAdminister: true },
                "grace"
            )
        ).toBe(true);
    });
});

describe("leaving", () => {
    it("is something anybody in a group may do", async () => {
        await chat.removeChannelMember(ada, "channel-1", "ada");
        expect(written.removed).toEqual(["ada"]);
    });

    it("is not something they may do to somebody else", async () => {
        // The rule that keeps a group a group.
        await expect(
            chat.removeChannelMember(ada, "channel-1", "grace")
        ).rejects.toThrow(/Only the person leaving/);
        expect(written.removed).toBeUndefined();
    });

    it("keeps the group while anybody is still in it", async () => {
        await chat.removeChannelMember(ada, "channel-1", "ada");
        expect(written.deleted).toBeUndefined();
    });

    it("takes the group with the last person out, files first", async () => {
        members = ["ada"];
        await chat.removeChannelMember(ada, "channel-1", "ada");
        expect(written.filesDiscarded).toEqual(["channel-1"]);
        expect(written.deleted).toEqual(["channel-1"]);
    });

    it("is refused in a one-to-one conversation, which is between two people", async () => {
        kind = "dm";
        await expect(chat.removeChannelMember(ada, "channel-1", "ada")).rejects.toThrow(
            /cannot be left/
        );
    });
});

/**
 * A group can also empty without anybody leaving: an account deleted takes its
 * memberships with it. The sweep is what keeps those from staying forever.
 */
describe("groups left with nobody in them", () => {
    it("are removed by the sweep, and one somebody joined in the meantime is kept", async () => {
        emptyGroups = ["channel-1"];
        members = [];
        expect(await chat.sweepEmptyGroups()).toEqual({ removed: 1 });
        expect(written.deleted).toEqual(["channel-1"]);

        written = {};
        members = ["grace"];
        expect(await chat.sweepEmptyGroups()).toEqual({ removed: 0 });
        expect(written.deleted).toBeUndefined();
    });
});
