/**
 * A membership row left behind in a space the reader no longer reaches.
 *
 * Reading a public channel leaves a row, and that row outlives the space turning
 * private or its organization being left. `channelAccess` refuses such a room,
 * so the rail and the unread badge must not list it, name it, or count it
 * either - hiding it only in the client is the leak a modded client reads.
 * Rows for direct messages, rooms in reachable spaces, and rooms granted on
 * their own keep working exactly as before.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Where = Record<string, unknown>;

interface Room {
    id: string;
    spaceId: string | null;
    private: boolean;
    archived: boolean;
}

let rooms: Room[] = [];
let memberOf: string[] = [];
let spaces = new Set<string>();
let grantedRooms = new Map<string, string>();

/** Enough of Prisma's where semantics for the clauses these reads build. */
function matches(room: Room, where: Where): boolean {
    return Object.entries(where).every(([key, wanted]) => {
        if (key === "OR") return (wanted as Where[]).some((branch) => matches(room, branch));
        const value = room[key as keyof Room];
        if (wanted === null) return value === null;
        if (typeof wanted === "object" && wanted && "in" in wanted) {
            return (wanted as { in: unknown[] }).in.includes(value);
        }
        return value === wanted;
    });
}

function shaped(room: Room) {
    return {
        ...room,
        orgId: null,
        categoryId: null,
        kind: room.spaceId ? "text" : "dm",
        name: room.id,
        topic: "",
        space: room.spaceId ? { archived: false } : null,
        lastMessageAt: null,
        ownerId: null,
        createdById: null,
        membersMayEdit: false,
        membersMayInvite: false,
        membersMayMention: false,
        slowmode: 0,
        userLimit: 0,
        contentMode: "all",
        members: []
    };
}

vi.mock("@polaris/auth", () => ({ can: async () => true }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/notices", () => ({
    postNotice: async () => undefined,
    postSpaceNotice: async () => undefined
}));
vi.mock("@/lib/chat/attachments", () => ({ discardChannelFiles: async () => undefined }));
vi.mock("@/lib/avatar-service", () => ({ discardAvatars: async () => undefined }));
vi.mock("@/lib/access/grants", () => ({
    dropGrantsFor: async () => undefined,
    grantedSubjects: async (_userId: string, subject: string) =>
        subject === "chat.channel" ? grantedRooms : new Map()
}));
vi.mock("@/lib/orgs/org-service", () => ({
    readsOrgWhere: () => ({}),
    memberOrgIds: async () => []
}));
vi.mock("@/lib/contact-names", () => ({ nicknamesFor: async () => new Map() }));
vi.mock("@/lib/blocks", () => ({
    blockedBy: async () => new Set(),
    blockedBetween: async () => new Set(),
    blockedIds: async () => []
}));
vi.mock("@/lib/chat/game-links", () => ({ gameLinksFor: async () => new Map() }));
vi.mock("@/lib/chat/isolation", () => ({
    readableChatScopes: async () => new Set([null]),
    currentChatOrgId: async () => null,
    orgChatPeople: async () => new Set()
}));
vi.mock("@/lib/chat/access", async (original) => ({
    ...(await original<typeof import("@/lib/chat/access")>()),
    reachableSpaceIds: async () => spaces
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        userBlock: { findMany: async () => [] },
        chatSpace: {
            findMany: async ({ where }: { where: { id?: { in: string[] } } }) =>
                [...new Set(rooms.map((room) => room.spaceId).filter(Boolean))]
                    .filter((id) => !where.id || where.id.in.includes(id as string))
                    .map((id) => ({ id, orgId: null }))
        },
        chatSpaceMember: { findMany: async () => [] },
        chatAgeConfirmation: { findMany: async () => [] },
        chatChannelMember: {
            findMany: async () =>
                memberOf.map((channelId) => ({
                    channelId,
                    lastReadAt: null,
                    muted: false,
                    mutedUntil: null,
                    notifyLevel: "inherit",
                    pinnedAt: null,
                    role: "member",
                    timeoutUntil: null
                }))
        },
        chatChannel: {
            findMany: async ({ where }: { where: Where }) =>
                rooms.filter((room) => matches(room, where)).map(shaped)
        },
        chatMessage: {
            // One unread message in every room the count is asked about.
            groupBy: async ({ where }: { where: { OR: { channelId: { in: string[] } }[] } }) =>
                where.OR.flatMap((branch) => branch.channelId.in).map((channelId) => ({
                    channelId,
                    _count: { _all: 1 }
                }))
        }
    }
}));

const { listChannels, unreadConversations } = await import("@/lib/chat/chat-service");

const room = (id: string, spaceId: string | null, extra: Partial<Room> = {}): Room => ({
    id,
    spaceId,
    private: spaceId === null,
    archived: false,
    ...extra
});

beforeEach(() => {
    rooms = [
        room("dm-1", null),
        room("lobby", "space-open"),
        room("backroom", "space-open", { private: true }),
        room("old-lobby", "space-gone"),
        room("old-backroom", "space-gone", { private: true }),
        room("handed", "space-gone", { private: true })
    ];
    // A row in every one of them, as reading or being added leaves behind.
    memberOf = rooms.map((entry) => entry.id);
    spaces = new Set(["space-open"]);
    grantedRooms = new Map([["handed", "member"]]);
});

describe("a membership in a space the reader no longer reaches", () => {
    it("is not listed on the rail", async () => {
        const listed = (await listChannels({ id: "user-1" })).map((entry) => entry.id).sort();
        expect(listed).toEqual(["backroom", "dm-1", "handed", "lobby"]);
    });

    it("is not described when asked for by id", async () => {
        expect(await listChannels({ id: "user-1" }, "old-backroom")).toEqual([]);
        expect(await listChannels({ id: "user-1" }, ["old-lobby", "lobby"])).toHaveLength(1);
    });

    it("is not counted on the unread badge", async () => {
        const counted = (await unreadConversations({ id: "user-1" }))
            .map((entry) => entry.id)
            .sort();
        expect(counted).toEqual(["backroom", "dm-1", "handed", "lobby"]);
    });

    it("leaves a public room in a reachable space listed without a row", async () => {
        memberOf = ["dm-1"];
        const listed = (await listChannels({ id: "user-1" })).map((entry) => entry.id).sort();
        expect(listed).toEqual(["dm-1", "lobby"]);
    });
});
