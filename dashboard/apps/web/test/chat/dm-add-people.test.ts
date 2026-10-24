/**
 * "Add people" in a one-to-one conversation, the way Discord does it.
 *
 * The people picked and the two already talking become a new group; the
 * conversation it was asked from is left exactly as it was - nobody is added to
 * it, and its private history is not handed to anybody. Asking again for the
 * same people opens the group that already holds exactly them.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/** The kind of the conversation the button was pressed in. */
let kind = "dm";
/** Who is in that conversation besides the reader. */
let partner: string | null = "grace";
/** A group already holding exactly the asked-for people, if any. */
let existingGroup: string | null = null;
/** Whoever the group-reach rule was asked about. */
let strangersAsked: string[] = [];
let written: {
    created?: { kind: string; ownerId: string; members: string[] };
    addedToDm?: string[];
    groupLookup?: unknown;
} = {};

vi.mock("@polaris/auth", () => ({ can: async () => true }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/blocks", () => ({
    blockedBetween: async () => new Set<string>(),
    blockedBy: async () => new Set<string>()
}));
vi.mock("@/lib/chat/group-reach", () => ({
    refuseGroupStrangers: async (_actor: unknown, ids: string[]) => {
        strangersAsked = ids;
    }
}));
vi.mock("@/lib/chat/isolation", () => ({
    currentChatOrgId: async () => null,
    orgChatPeople: async () => new Set<string>(),
    readableChatScopes: async () => []
}));
vi.mock("@/lib/chat/access", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/chat/access")>()),
    requireChannel: async () => ({ kind, spaceId: null, mayAdminister: false }),
    messageable: async (ids: readonly string[]) => new Set(ids)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.map((id) => ({ id, name: id }))
        },
        chatChannelMember: {
            findFirst: async () => (partner ? { userId: partner } : null),
            createMany: async ({ data }: { data: { userId: string }[] }) => {
                written.addedToDm = data.map((row) => row.userId);
                return { count: data.length };
            }
        },
        chatChannel: {
            findFirst: async (query: unknown) => {
                written.groupLookup = query;
                return existingGroup ? { id: existingGroup } : null;
            },
            create: async ({
                data
            }: {
                data: {
                    kind: string;
                    ownerId: string;
                    members: { createMany: { data: { userId: string }[] } };
                };
            }) => {
                written.created = {
                    kind: data.kind,
                    ownerId: data.ownerId,
                    members: data.members.createMany.data.map((row) => row.userId)
                };
                return { id: "new-group" };
            }
        }
    }
}));

const chat = await import("@/lib/chat/chat-service");
const { ChatAccessError } = await import("@/lib/chat/access");
const core = await import("@polaris/core");

const ada = { id: "ada" };

beforeEach(() => {
    kind = "dm";
    partner = "grace";
    existingGroup = null;
    strangersAsked = [];
    written = {};
});

describe("adding people to a one-to-one conversation", () => {
    it("makes a new group of the two of you and them, and leaves the conversation alone", async () => {
        const id = await chat.groupFromDirect(ada, "dm-1", ["alan", "alan", "ada", "grace"]);
        expect(id).toBe("new-group");
        expect(written.created).toEqual({
            kind: "group",
            ownerId: "ada",
            members: ["ada", "grace", "alan"]
        });
        // Nobody was put into the one-to-one itself.
        expect(written.addedToDm).toBeUndefined();
    });

    it("asks the friends-and-colleagues rule only about the newcomers", async () => {
        await chat.groupFromDirect(ada, "dm-1", ["alan", "linus"]);
        expect(strangersAsked).toEqual(["alan", "linus"]);
    });

    it("opens the group that already holds exactly those people instead of a second one", async () => {
        existingGroup = "group-7";
        const id = await chat.groupFromDirect(ada, "dm-1", ["alan"]);
        expect(id).toBe("group-7");
        expect(written.created).toBeUndefined();
        // Exactly that set: nobody outside it, and each of them present.
        const where = (written.groupLookup as { where: Record<string, unknown> }).where;
        expect(where.kind).toBe("group");
        expect(where.members).toEqual({ every: { userId: { in: ["ada", "grace", "alan"] } } });
        expect(where.AND).toHaveLength(3);
    });

    it("is refused outside a one-to-one conversation", async () => {
        kind = "group";
        await expect(chat.groupFromDirect(ada, "g-1", ["alan"])).rejects.toBeInstanceOf(
            ChatAccessError
        );
    });

    it("needs somebody new to add", async () => {
        await expect(chat.groupFromDirect(ada, "dm-1", ["grace", "ada"])).rejects.toBeInstanceOf(
            ChatAccessError
        );
    });

    it("stops at the size a group holds, counting the two already talking", async () => {
        const many = Array.from({ length: core.MAX_GROUP_MEMBERS - 1 }, (_, i) => `p${i}`);
        await expect(chat.groupFromDirect(ada, "dm-1", many)).rejects.toBeInstanceOf(
            ChatAccessError
        );
        expect(written.created).toBeUndefined();
    });

    it("is refused when the other side of the conversation is gone", async () => {
        partner = null;
        await expect(chat.groupFromDirect(ada, "dm-1", ["alan"])).rejects.toBeInstanceOf(
            ChatAccessError
        );
    });
});

describe("the action's schema", () => {
    it("takes a conversation and at most the seats a group has left", () => {
        const id = "00000000-0000-4000-8000-000000000001";
        expect(
            core.chatGroupFromDirectSchema.safeParse({ channelId: id, userIds: [id] }).success
        ).toBe(true);
        expect(
            core.chatGroupFromDirectSchema.safeParse({ channelId: id, userIds: [] }).success
        ).toBe(false);
        expect(
            core.chatGroupFromDirectSchema.safeParse({
                channelId: "nope",
                userIds: [id]
            }).success
        ).toBe(false);
    });
});
