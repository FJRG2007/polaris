/**
 * A mention gets through a mute, as in Discord, WhatsApp and Telegram: a
 * message that names the reader, or replies to them, still raises the toast -
 * and with it the chime and the desktop notice - through the conversation's
 * own mute and through Chat muted as a whole, and an `@everyone` still writes
 * its notification. Only a mute set to hold mentions too keeps them out, and a
 * conversation set to nothing hears nothing at all, as Discord's "Nothing" does.
 */

import * as core from "@polaris/core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const READER = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

const state = vi.hoisted(() => ({
    level: "all" as string,
    /** The reader's row in the conversation, or null for none. */
    member: null as null | { muted: boolean; mutedUntil: Date | null; muteMentions: boolean },
    holds: null as string | null,
    body: "hello",
    replyToId: null as string | null,
    forwarded: false,
    /** The messages the reader wrote, by id. */
    mine: new Set<string>(),
    notified: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannelMember: {
            findMany: async (query: { where: { muted?: boolean; channelId?: unknown } }) => {
                const row = state.member;
                if (query.where.muted) {
                    return row?.muted
                        ? [{ channelId: "c1", userId: READER, ...row }]
                        : [];
                }
                // The room's roster, or the reader's own rows for a toast.
                return [{ channelId: "c1", userId: READER, locked: false, lastReadAt: null }];
            }
        },
        chatChannel: {
            findUnique: async () => ({
                id: "c1",
                name: "general",
                kind: "channel",
                spaceId: null,
                private: true,
                orgId: null,
                space: null
            })
        },
        chatMessage: {
            findMany: async (query: { where: { id?: { in: string[] }; authorId?: unknown } }) => {
                if (query.where.id) {
                    return query.where.id.in.filter((id) => state.mine.has(id)).map((id) => ({ id }));
                }
                return [
                    {
                        id: "bob-says",
                        createdAt: new Date(Date.now() - 1000),
                        authorId: BOB,
                        channelId: "c1",
                        body: state.body,
                        replyToId: state.replyToId,
                        forwarded: state.forwarded,
                        attachments: [],
                        channel: { name: "general", kind: "channel", spaceId: "s1", members: [] }
                    }
                ];
            }
        },
        user: {
            findMany: async (query: { where: { notifyHolds?: unknown; id: { in: string[] } } }) => {
                if (query.where.notifyHolds) {
                    return state.holds && query.where.id.in.includes(READER)
                        ? [{ id: READER, notifyHolds: state.holds }]
                        : [];
                }
                return [{ id: BOB, name: "Bob" }];
            },
            findUnique: async () => ({ name: "Bob" })
        }
    }
}));
vi.mock("@/lib/chat/access", () => ({
    reachableChannelIds: async () => new Set(["c1"]),
    ChatAccessError: class extends Error {},
    roomMentionsAllowed: () => true
}));
vi.mock("@/lib/chat/notify", async () => {
    const actual = await vi.importActual<typeof import("@/lib/chat/notify")>("@/lib/chat/notify");
    return {
        ...actual,
        notifyLevels: async (_userId: string, ids: readonly string[]) =>
            new Map(ids.map((id) => [id, state.level])),
        readerTeams: async () => new Set<string>(),
        silencedIn: async (_channelId: string, ids: readonly string[]) =>
            new Set(state.level === "none" ? ids : [])
    };
});
vi.mock("@/lib/chat/history-visibility", () => ({
    historyFloors: async () => new Map(),
    readableWhere: () => ({})
}));
vi.mock("@/lib/chat/age-gate", () => ({ ageClearedWhere: () => ({}) }));
vi.mock("@/lib/blocks", () => ({
    blockedBy: async () => new Set(),
    blockersOf: async () => new Set()
}));
vi.mock("@/lib/chat/chat-lock", () => ({
    redactAlert: <T>(toast: T) => toast,
    lockedFor: async () => new Set()
}));
vi.mock("@/lib/notifications/presence", () => ({ onlineUserIds: () => new Set([READER]) }));
vi.mock("@/lib/notification-service", () => ({
    createNotification: async (input: { userId: string }) => {
        state.notified.push(input.userId);
    }
}));
vi.mock("@/lib/chat/isolation", () => ({ chatAlertShelf: async () => null }));
vi.mock("@/lib/chat/text", () => ({ chatWordsFor: async () => (key: string) => key }));
vi.mock("@/lib/workspace-scope", () => ({ recipientShelf: async () => null }));

const { messageToasts } = await import("@/lib/chat/toasts");
const { announceRoomMention } = await import("@/lib/chat/room-mentions");

const actor = { id: READER } as Parameters<typeof messageToasts>[0];
const MENTION = `[@Reader](polaris:user/${READER}) look`;
const appMute = (mentions?: boolean) =>
    JSON.stringify({ mutes: { "app:chat": { until: null, ...(mentions ? { mentions } : {}) } } });
const muted = (muteMentions = false) => ({ muted: true, mutedUntil: null, muteMentions });

async function toasted(): Promise<boolean> {
    return (await messageToasts(actor, ["c1"])).length > 0;
}

beforeEach(() => {
    state.level = "all";
    state.member = null;
    state.holds = null;
    state.body = "hello";
    state.replyToId = null;
    state.forwarded = false;
    state.mine = new Set();
    state.notified = [];
});

describe("the rule", () => {
    it("lets a mention through a mute unless the mute holds mentions too", () => {
        const conversation = { ...core.CHAT_UNMUTED, conversation: true };
        expect(core.chatMuteHolds(core.CHAT_UNMUTED, false)).toBe(false);
        expect(core.chatMuteHolds(conversation, false)).toBe(true);
        expect(core.chatMuteHolds(conversation, true)).toBe(false);
        expect(core.chatMuteHolds({ ...conversation, conversationMentions: true }, true)).toBe(
            true
        );
        const app = { ...core.CHAT_UNMUTED, app: true };
        expect(core.chatMuteHolds(app, true)).toBe(false);
        expect(core.chatMuteHolds({ ...app, appMentions: true }, true)).toBe(true);
    });
});

describe("a toast in a muted conversation", () => {
    it("is not raised for an ordinary message", async () => {
        state.member = muted();
        expect(await toasted()).toBe(false);
    });

    it("is raised for a message that names the reader", async () => {
        state.member = muted();
        state.body = MENTION;
        expect(await toasted()).toBe(true);
    });

    it("is raised for a reply to the reader's own message", async () => {
        state.member = muted();
        state.replyToId = "mine-1";
        state.mine = new Set(["mine-1"]);
        expect(await toasted()).toBe(true);
    });

    it("is not raised for a forward of the reader's message", async () => {
        state.member = muted();
        state.replyToId = "mine-1";
        state.forwarded = true;
        state.mine = new Set(["mine-1"]);
        expect(await toasted()).toBe(false);
    });

    it("is not raised for a mention once the mute holds mentions too", async () => {
        state.member = muted(true);
        state.body = MENTION;
        expect(await toasted()).toBe(false);
    });

    it("is raised again once the mute has run out", async () => {
        state.member = { muted: true, mutedUntil: new Date(Date.now() - 60_000), muteMentions: true };
        expect(await toasted()).toBe(true);
    });
});

describe("a toast with Chat muted as a whole", () => {
    it("is not raised for an ordinary message", async () => {
        state.holds = appMute();
        expect(await toasted()).toBe(false);
    });

    it("is raised for a mention", async () => {
        state.holds = appMute();
        state.body = MENTION;
        expect(await toasted()).toBe(true);
    });

    it("is not raised for a mention once that mute holds mentions too", async () => {
        state.holds = appMute(true);
        state.body = MENTION;
        expect(await toasted()).toBe(false);
    });
});

describe("a conversation set to nothing", () => {
    it("is not interrupted even by a mention, as Discord's Nothing", async () => {
        state.level = "none";
        state.body = MENTION;
        expect(await toasted()).toBe(false);
    });
});

describe("@everyone in a muted conversation", () => {
    it("still notifies, as Discord's mute lets @everyone through", async () => {
        state.member = muted();
        await announceRoomMention("c1", BOB, "@everyone deploy at five", "m1");
        expect(state.notified).toEqual([READER]);
    });

    it("still notifies with Chat muted as a whole", async () => {
        state.holds = appMute();
        await announceRoomMention("c1", BOB, "@everyone deploy at five", "m1");
        expect(state.notified).toEqual([READER]);
    });

    it("does not notify once the mute holds mentions too", async () => {
        state.member = muted(true);
        await announceRoomMention("c1", BOB, "@everyone deploy at five", "m1");
        expect(state.notified).toEqual([]);
    });

    it("does not notify in a conversation set to nothing", async () => {
        state.level = "none";
        await announceRoomMention("c1", BOB, "@everyone deploy at five", "m1");
        expect(state.notified).toEqual([]);
    });
});
