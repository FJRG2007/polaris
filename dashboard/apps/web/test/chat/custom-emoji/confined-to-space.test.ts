/**
 * A space's emoji works in that space and nowhere else - enforced on the write.
 *
 * The picker only offers a space's own emoji inside it, but anybody can paste a
 * token or send one through the API. So the send, the edit and the reaction each
 * check it here: a token from another space, or one deleted since, lands as the
 * `:name:` it was typed as, a reaction with one is refused, and a direct message
 * carries none at all. Taking back a reaction whose emoji has since been deleted
 * is still allowed - it is the one thing left to do with it.
 */

import { DEFAULT_CHAT_RULES } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HOME = "0193b0f0-0000-7000-8000-0000000000a1";
const ELSEWHERE = "0193b0f0-0000-7000-8000-0000000000a2";
const WAVE = "0193b0f0-0000-7000-8000-0000000000e1";
const DANCE = "0193b0f0-0000-7000-8000-0000000000e2";
const FOREIGN = "0193b0f0-0000-7000-8000-0000000000e3";
const DELETED = "0193b0f0-0000-7000-8000-0000000000e4";
const SENT = new Date("2026-08-15T12:00:00Z");

/** Every emoji there is, by space. `DELETED` is in none. */
const EMOJI = [
    { id: WAVE, spaceId: HOME, name: "wave", animated: false },
    { id: DANCE, spaceId: HOME, name: "dance_party", animated: true },
    { id: FOREIGN, spaceId: ELSEWHERE, name: "theirs", animated: false }
];

/** The conversation's space, or null for a direct message. */
let channelSpace: string | null = HOME;
let created: string[] = [];
let edited: string[] = [];
let reactions: { id: string; emoji: string }[] = [];

vi.mock("@/lib/chat/rules", () => ({ rulesForChannel: async () => DEFAULT_CHAT_RULES }));
vi.mock("@/lib/chat/attachments", () => ({
    CHAT_LOCAL_FOLDER: "chat",
    chatTarget: async () => ({ id: "local" }),
    readStored: async () => null,
    isInlineImage: () => false,
    discardAttachments: async () => undefined,
    removeStoredFiles: async () => undefined
}));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));

vi.mock("@/lib/chat/access", async (importActual) => {
    const actual = await importActual<typeof import("@/lib/chat/access")>();
    const access = () => ({
        channelId: "channel-1",
        spaceId: channelSpace,
        kind: channelSpace ? "text" : "dm",
        archived: false,
        member: true,
        mayPost: true,
        mutedUntil: null,
        mayAdminister: false,
        mayModerate: false
    });
    return {
        ...actual,
        requirePostable: async () => access(),
        requireChannel: async () => access()
    };
});

vi.mock("@polaris/db", () => {
    const client = {
        userBlock: { findMany: async () => [] },
        chatChannel: {
            findUnique: async () => ({
                id: "channel-1",
                spaceId: channelSpace,
                kind: channelSpace ? "text" : "dm",
                ownerId: "ada",
                createdById: "ada",
                membersMayMention: true,
                private: false,
                archived: false,
                space: null
            }),
            update: async () => undefined
        },
        chatSpace: { findUnique: async () => null },
        chatSpaceMember: { findUnique: async () => null },
        chatChannelMember: {
            findUnique: async () => ({ role: "member" }),
            findMany: async () => [],
            upsert: async () => undefined
        },
        chatSpaceEmoji: {
            findMany: async ({ where }: { where: { spaceId: string; id: { in: string[] } } }) =>
                EMOJI.filter((one) => one.spaceId === where.spaceId && where.id.in.includes(one.id))
        },
        chatMessage: {
            findUnique: async () => ({
                id: "message-1",
                kind: "text",
                channelId: "channel-1",
                authorId: "ada",
                body: "before",
                parentId: null,
                deletedAt: null,
                createdAt: SENT
            }),
            findFirst: async () => null,
            findMany: async () => [],
            count: async () => 0,
            create: async ({ data }: { data: { body: string } }) => {
                created.push(data.body);
                return { id: "new", createdAt: SENT };
            },
            update: async ({ data }: { data: { body?: string } }) => {
                if (data.body !== undefined) edited.push(data.body);
                return {};
            }
        },
        chatMessageEdit: { create: async () => ({}) },
        chatReaction: {
            findFirst: async ({ where }: { where: { emoji: { endsWith: string } } }) =>
                reactions.find((one) => one.emoji.endsWith(where.emoji.endsWith)) ?? null,
            findUnique: async ({
                where
            }: {
                where: { messageId_userId_emoji: { emoji: string } };
            }) => reactions.find((one) => one.emoji === where.messageId_userId_emoji.emoji) ?? null,
            create: async ({ data }: { data: { emoji: string } }) => {
                reactions.push({ id: crypto.randomUUID(), emoji: data.emoji });
                return {};
            },
            delete: async ({ where }: { where: { id: string } }) => {
                reactions = reactions.filter((one) => one.id !== where.id);
                return {};
            }
        },
        user: { findMany: async () => [], findUnique: async () => null },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(client)
    };
    return { prisma: client };
});

const { send, edit, react } = await import("@/lib/chat/messages");
const { ChatAccessError } = await import("@/lib/chat/access");

const ada = { id: "ada" };
const say = (body: string) => send(ada, { channelId: "channel-1", body, parentId: null });
const press = (emoji: string) => react(ada, { messageId: "message-1", emoji });

beforeEach(() => {
    channelSpace = HOME;
    created = [];
    edited = [];
    reactions = [];
});

describe("sending a space's emoji", () => {
    it("keeps the space's own as the token", async () => {
        await say(`hi <:wave:${WAVE}> <a:dance_party:${DANCE}>`);
        expect(created).toEqual([`hi <:wave:${WAVE}> <a:dance_party:${DANCE}>`]);
    });

    it("writes one from another space as its name", async () => {
        await say(`look <:theirs:${FOREIGN}>`);
        expect(created).toEqual(["look :theirs:"]);
    });

    it("writes a deleted one as its name", async () => {
        await say(`<:old:${DELETED}> still here`);
        expect(created).toEqual([":old: still here"]);
    });

    it("carries none at all in a direct message", async () => {
        channelSpace = null;
        await say(`hi <:wave:${WAVE}>`);
        expect(created).toEqual(["hi :wave:"]);
    });

    it("stores the current name and kind, whatever the token claimed", async () => {
        await say(`<a:renamed_since:${WAVE}> <:dance:${DANCE}>`);
        expect(created).toEqual([`<:wave:${WAVE}> <a:dance_party:${DANCE}>`]);
    });

    it("is held to the same rule on an edit", async () => {
        await edit(ada, {
            messageId: "message-1",
            body: `edited <:theirs:${FOREIGN}> <:wave:${WAVE}>`
        });
        expect(edited).toEqual([`edited :theirs: <:wave:${WAVE}>`]);
    });
});

describe("reacting with a space's emoji", () => {
    it("works inside its space", async () => {
        await expect(press(`<:wave:${WAVE}>`)).resolves.toBe(true);
        expect(reactions.map((one) => one.emoji)).toEqual([`<:wave:${WAVE}>`]);
    });

    it("is refused from another space and in a direct message", async () => {
        await expect(press(`<:theirs:${FOREIGN}>`)).rejects.toBeInstanceOf(ChatAccessError);
        channelSpace = null;
        await expect(press(`<:wave:${WAVE}>`)).rejects.toBeInstanceOf(ChatAccessError);
        expect(reactions).toEqual([]);
    });

    it("is refused once the emoji is deleted", async () => {
        await expect(press(`<:old:${DELETED}>`)).rejects.toThrow(/belongs to another space/);
    });

    it("is one reaction by id, so pressing it under an old name takes it back", async () => {
        await press(`<:wave:${WAVE}>`);
        await expect(press(`<:old_name:${WAVE}>`)).resolves.toBe(false);
        expect(reactions).toEqual([]);
    });

    it("can still be taken back after the emoji was deleted", async () => {
        reactions = [{ id: "r1", emoji: `<:old:${DELETED}>` }];
        await expect(press(`<:old:${DELETED}>`)).resolves.toBe(false);
        expect(reactions).toEqual([]);
    });

    it("leaves ordinary emoji as they were", async () => {
        channelSpace = null;
        await expect(press("👍")).resolves.toBe(true);
        expect(reactions.map((one) => one.emoji)).toEqual(["👍"]);
    });
});
