/**
 * What the conversation list reads to draw itself.
 *
 * What is pinned: the people in a conversation are read only where the list
 * uses them - a direct message or a group, which are named after and drawn with
 * who is in them - and never for a channel in a space, which can hold everybody
 * on the instance and whose list entry shows none of them; one conversation can
 * be described alone, by the same rules, for the header of a conversation
 * opened before the list; and finding the conversation with somebody writes
 * nothing, and refuses exactly as opening one does.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Query = { where?: Record<string, unknown>; select?: Record<string, unknown> };

let channelQueries: Query[] = [];
let created = 0;
let blocked = false;

const row = (id: string, spaceId: string | null, kind: string, members: string[]) => ({
    id,
    spaceId,
    orgId: null,
    categoryId: null,
    kind,
    name: spaceId ? id : "",
    topic: "",
    private: !spaceId,
    archived: false,
    lastMessageAt: null,
    ownerId: null,
    createdById: null,
    membersMayEdit: false,
    membersMayInvite: false,
    membersMayMention: false,
    slowmode: 0,
    userLimit: 0,
    members: members.map((userId) => ({ userId, user: { name: userId } }))
});

vi.mock("@polaris/auth", () => ({ can: async () => true }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/notices", () => ({
    postNotice: async () => undefined,
    postSpaceNotice: async () => undefined
}));
vi.mock("@/lib/chat/attachments", () => ({ discardChannelFiles: async () => undefined }));
vi.mock("@/lib/avatar-service", () => ({ discardAvatars: async () => undefined }));
vi.mock("@/lib/access/grants", () => ({ dropGrantsFor: async () => undefined }));
vi.mock("@/lib/orgs/org-service", () => ({ readsOrgWhere: () => ({}), memberOrgIds: async () => [] }));
vi.mock("@/lib/contact-names", () => ({ nicknamesFor: async () => new Map() }));
vi.mock("@/lib/blocks", () => ({
    blockedBy: async () => new Set(),
    blockedBetween: async () => (blocked ? new Set(["grace"]) : new Set())
}));
vi.mock("@/lib/chat/game-links", () => ({ gameLinksFor: async () => new Map() }));
vi.mock("@/lib/chat/isolation", () => ({
    readableChatScopes: async () => new Set([null]),
    currentChatOrgId: async () => null,
    orgChatPeople: async () => new Set()
}));
vi.mock("@/lib/chat/access", async (original) => ({
    ...(await original<typeof import("@/lib/chat/access")>()),
    reachableSpaceIds: async () => new Set(["s1"]),
    messageable: async (ids: readonly string[]) => new Set(ids)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        userBlock: { findMany: async () => [] },
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => ({ id, name: id }))
        },
        chatSpace: { findMany: async () => [{ id: "s1", orgId: null }] },
        chatSpaceMember: { findMany: async () => [] },
        chatChannelMember: {
            findMany: async () => [
                {
                    channelId: "dm",
                    lastReadAt: null,
                    muted: false,
                    mutedUntil: null,
                    notifyLevel: "inherit",
                    pinnedAt: null,
                    role: "member"
                }
            ]
        },
        chatChannel: {
            findMany: async (query: Query) => {
                channelQueries.push(query);
                const rows = [row("dm", null, "dm", ["ada", "grace"]), row("general", "s1", "text", [])];
                const only = query.where?.id;
                return typeof only === "string" ? rows.filter((entry) => entry.id === only) : rows;
            },
            findUnique: async ({ where }: { where: { dmKey?: string } }) =>
                where.dmKey === "ada:grace" ? { id: "dm" } : null,
            create: async () => {
                created += 1;
                return { id: "new" };
            }
        },
        chatMessage: { groupBy: async () => [] }
    }
}));

const chat = await import("@/lib/chat/chat-service");

beforeEach(() => {
    channelQueries = [];
    created = 0;
    blocked = false;
});

describe("the conversation list", () => {
    it("reads who is in a conversation only where the list names them", async () => {
        const listed = await chat.listChannels({ id: "ada" });
        const members = channelQueries[0]?.select?.members as { where?: unknown };
        expect(members.where).toEqual({ channel: { spaceId: null } });
        expect(listed.find((entry) => entry.id === "dm")?.others).toEqual([
            { id: "grace", name: "grace" }
        ]);
        expect(listed.find((entry) => entry.id === "general")?.others).toEqual([]);
    });

    it("describes one conversation alone, by the same rules", async () => {
        const described = await chat.listChannels({ id: "ada" }, "dm");
        expect(channelQueries[0]?.where?.id).toBe("dm");
        expect(described.map((entry) => entry.id)).toEqual(["dm"]);
        expect(described[0]?.name).toBe("grace");
    });
});

describe("finding the conversation with somebody", () => {
    it("finds one that exists and writes nothing", async () => {
        await expect(chat.existingDirect({ id: "ada" }, "grace")).resolves.toBe("dm");
        expect(created).toBe(0);
    });

    it("answers null where opening would have to create it", async () => {
        await expect(chat.existingDirect({ id: "ada" }, "linus")).resolves.toBeNull();
        expect(created).toBe(0);
    });

    it("refuses as opening does", async () => {
        blocked = true;
        await expect(chat.existingDirect({ id: "ada" }, "grace")).rejects.toThrow(
            "You cannot start that conversation"
        );
        await expect(chat.openDirect({ id: "ada" }, ["grace"])).rejects.toThrow(
            "You cannot start that conversation"
        );
    });
});
