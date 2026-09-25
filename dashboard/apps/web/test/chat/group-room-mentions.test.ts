/**
 * `@everyone` and `@here` in a group whose owner has kept them to themselves.
 *
 * The switch is only worth anything on the server: the composer stops offering
 * the words, but anybody can type them out, and every place that reads a
 * message decides "this names me" from the text alone. So a message from a
 * member that names the room is refused before it is written, an edit that
 * adds one is refused the same way, and one scheduled for later is refused when
 * it is scheduled rather than discovered when it fails to go.
 *
 * What must not change is everybody else: the owner, a group that left the
 * switch alone, a direct message, and a message that merely talks about
 * `@everyone` inside a code block.
 */

import { DEFAULT_CHAT_RULES } from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ChatAccessError, roomMentionsAllowed } from "@/lib/chat/access";

const SENT = new Date("2026-08-15T12:00:00Z");

let kind = "group";
/** Whether the owner has let the rest of the group name the room. */
let membersMayMention = true;
/** What the message being edited said when it went. */
let stored = "before";

let created: string[] = [];
let edited: string[] = [];
let scheduled: string[] = [];

vi.mock("@/lib/chat/rules", () => ({
    rulesForChannel: async () => DEFAULT_CHAT_RULES
}));

vi.mock("@/lib/chat/attachments", () => ({
    isInlineImage: () => false,
    discardAttachments: async () => undefined,
    removeStoredFiles: async () => undefined
}));

vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: async () => [] }));

vi.mock("@polaris/db", () => {
    const client = {
        userBlock: { findMany: async () => [] },
        chatChannel: {
            findUnique: async () => ({
                id: "channel-1",
                spaceId: null,
                kind,
                ownerId: "ada",
                createdById: "ada",
                membersMayMention,
                private: true,
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
        chatMessage: {
            findUnique: async () => ({
                id: "message-1",
                kind: "text",
                channelId: "channel-1",
                authorId: "grace",
                body: stored,
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
        chatScheduledMessage: {
            create: async ({ data }: { data: { body: string } }) => {
                scheduled.push(data.body);
                return { id: "scheduled-1" };
            }
        },
        user: { findMany: async () => [], findUnique: async () => null },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(client)
    };
    return { prisma: client };
});

const { send, edit } = await import("@/lib/chat/messages");
const { scheduleMessage } = await import("@/lib/chat/scheduled");

const ada = { id: "ada" };
const grace = { id: "grace" };

const say = (actor: { id: string }, body: string) =>
    send(actor, { channelId: "channel-1", body, parentId: null });

beforeEach(() => {
    kind = "group";
    membersMayMention = true;
    stored = "before";
    created = [];
    edited = [];
    scheduled = [];
    vi.setSystemTime(new Date("2026-08-15T12:30:00Z"));
});

describe("who may use @everyone and @here in a group", () => {
    it("is everybody until the owner closes it", async () => {
        await say(grace, "@everyone lunch?");
        await say(grace, "@here anyone around?");
        expect(created).toEqual(["@everyone lunch?", "@here anyone around?"]);
    });

    it("is refused on the server to a member once the owner has closed it", async () => {
        membersMayMention = false;
        await expect(say(grace, "@everyone lunch?")).rejects.toBeInstanceOf(ChatAccessError);
        await expect(say(grace, "quick one @here")).rejects.toThrow(
            /Only the owner of this group can use @everyone and @here/
        );
        // `@all` is a spelling of `@everyone` the parser takes, so it is the same.
        await expect(say(grace, "@all standup")).rejects.toBeInstanceOf(ChatAccessError);
        expect(created).toEqual([]);
    });

    it("stays open to the owner when it is closed", async () => {
        membersMayMention = false;
        await say(ada, "@everyone we moved to Friday");
        expect(created).toEqual(["@everyone we moved to Friday"]);
    });

    it("leaves every other message from a member alone", async () => {
        membersMayMention = false;
        await say(grace, "see you all tomorrow");
        // Inside a code block it is code, not a ping, which the parse knows.
        await say(grace, "type `@everyone` to ping the room");
        await say(grace, "mail me at grace@here.example");
        expect(created).toHaveLength(3);
    });

    it("is not a question in a direct message", async () => {
        kind = "dm";
        membersMayMention = false;
        await say(grace, "@everyone hi");
        expect(created).toEqual(["@everyone hi"]);
    });

    it("refuses an edit that adds one", async () => {
        membersMayMention = false;
        await expect(
            edit(grace, { messageId: "message-1", body: "@everyone after" })
        ).rejects.toBeInstanceOf(ChatAccessError);
        expect(edited).toEqual([]);
    });

    it("lets a member fix a message that already named the room when it went", async () => {
        membersMayMention = false;
        stored = "@everyone lnuch?";
        await edit(grace, { messageId: "message-1", body: "@everyone lunch?" });
        expect(edited).toEqual(["@everyone lunch?"]);
    });

    it("refuses one scheduled for later when it is scheduled", async () => {
        membersMayMention = false;
        await expect(
            scheduleMessage(grace, {
                channelId: "channel-1",
                body: "@here reminder",
                parentId: null,
                replyToId: null,
                forwarded: false,
                sendAt: "2026-08-16T09:00:00Z"
            })
        ).rejects.toBeInstanceOf(ChatAccessError);
        expect(scheduled).toEqual([]);
    });

    it("is decided the same way for the composer as for the send", () => {
        const group = { kind: "group", ownerId: "ada", membersMayMention: false };
        expect(roomMentionsAllowed(group, "ada")).toBe(true);
        expect(roomMentionsAllowed(group, "grace")).toBe(false);
        expect(roomMentionsAllowed({ ...group, membersMayMention: true }, "grace")).toBe(true);
        // A group made before the owner column was filled in is its creator's.
        const unowned = { ...group, ownerId: null, createdById: "ada" };
        expect(roomMentionsAllowed(unowned, "ada")).toBe(true);
        // Only a group has the switch; a channel and a direct message are as before.
        expect(roomMentionsAllowed({ ...group, kind: "text" }, "grace")).toBe(true);
        expect(roomMentionsAllowed({ ...group, kind: "dm" }, "grace")).toBe(true);
    });
});
