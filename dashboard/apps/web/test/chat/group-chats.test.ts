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
let members = ["ada", "grace", "alan"];
let written: { name?: string; removed?: string[]; added?: string[] } = {};

vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

vi.mock("@polaris/auth", () => ({
    can: async () => true
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: {
            findUnique: async () => ({
                id: "channel-1",
                spaceId: null,
                kind,
                private: true,
                archived: false,
                space: null
            }),
            update: async ({ data }: { data: { name?: string } }) => {
                written.name = data.name;
                return {};
            }
        },
        chatChannelMember: {
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
                return { count: 1 };
            }
        },
        user: { findMany: async () => [] },
        chatSpace: { findMany: async () => [] }
    }
}));

const chat = await import("@/lib/chat/chat-service");
const { ChatAccessError } = await import("@/lib/chat/access");

const ada = { id: "ada" };

beforeEach(() => {
    kind = "group";
    members = ["ada", "grace", "alan"];
    written = {};
});

describe("naming a group", () => {
    it("is anybody in it", async () => {
        await chat.renameGroup(ada, "channel-1", "Weekend plans");
        // Kept as written, not slugged: a channel's name is an identifier and a
        // group's is a label somebody typed.
        expect(written.name).toBe("Weekend plans");
    });

    it("can be taken off again, putting the names back", async () => {
        await chat.renameGroup(ada, "channel-1", "");
        expect(written.name).toBe("");
    });

    it("is refused to somebody not in it", async () => {
        members = ["grace", "alan"];
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

    it("is refused in a one-to-one conversation, which is between two people", async () => {
        kind = "dm";
        await expect(chat.removeChannelMember(ada, "channel-1", "ada")).rejects.toThrow(
            /cannot be left/
        );
    });
});
