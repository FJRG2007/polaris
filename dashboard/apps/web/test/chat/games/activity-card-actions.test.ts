/**
 * Inviting people to play and reading the card, as the server decides them:
 * the app installed, `arcade.calls`, a game the app offers, a rate limit on
 * invitations, and the card only for somebody in its conversation.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const SESSION = "0192f6a0-0000-7000-8000-0000000000bb";
const CHANNEL = "0192f6a0-0000-7000-8000-0000000000cc";
const MEETING = "0192f6a0-0000-7000-8000-0000000000aa";
const FRIEND = "0192f6a0-0000-7000-8000-0000000000dd";

const state = vi.hoisted(() => ({
    can: new Set<string>(),
    installed: true,
    limited: false,
    member: true,
    notified: [] as string[],
    limitKeys: [] as string[],
    session: null as null | Record<string, unknown>
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        meeting: { findUnique: async () => ({ endedAt: null }) },
        user: {
            findMany: async () => [{ id: "user-1", name: "Fixture Host" }]
        },
        arcadeSession: { update: async () => ({}) },
        chatChannel: { findUnique: async () => ({ kind: "group", members: [] }) }
    }
}));
vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "user-1", name: "Fixture Host" }),
    sessionCan: async (_user: unknown, permission: string) => state.can.has(permission)
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string) => {
        state.limitKeys.push(key);
        return { ok: !state.limited, retryAfterMs: 0 };
    }
}));
vi.mock("@/lib/chat/access", () => ({
    requireChannel: async () => {
        if (!state.member) throw new Error("not a member");
        return {};
    }
}));
vi.mock("@/lib/chat/meetings", () => ({ startOrJoin: async () => ({ meetingId: MEETING }) }));
vi.mock("@/lib/chat/chat-service", () => ({
    openDirect: async () => CHANNEL,
    listChannels: async () => []
}));
vi.mock("@/lib/i18n/translate", () => ({
    translatorFor: () => (key: string) => key
}));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => state.installed }));
vi.mock("@/lib/notification-service", () => ({
    createNotification: async (input: { userId: string }) => {
        state.notified.push(input.userId);
    }
}));
vi.mock("@/lib/app-extensions/registry", () => ({
    callActivityGames: async () => [{ id: "new-york", name: "New York", src: "/x" }]
}));
vi.mock("@/lib/chat/activity-sessions", () => ({
    openSession: async () => ({
        id: SESSION,
        channelId: CHANNEL,
        game: "new-york",
        messageId: null
    }),
    sessionForCard: async () => state.session
}));

const actions = await import("@/app/(app)/chat/activity-card-actions");

beforeEach(() => {
    state.can = new Set(["arcade.calls"]);
    state.installed = true;
    state.limited = false;
    state.member = true;
    state.notified = [];
    state.limitKeys = [];
    state.session = {
        id: SESSION,
        channelId: CHANNEL,
        meetingId: MEETING,
        game: "new-york",
        messageId: null,
        startedById: "user-1",
        createdAt: new Date(Date.now() - 1000),
        endedAt: null,
        players: [{ userId: "user-1", seenAt: new Date(), leftAt: null }]
    };
});

describe("inviting people to play", () => {
    it("opens the session and tells the people picked", async () => {
        const answer = await actions.inviteToGame({ game: "new-york", userIds: [FRIEND] });
        expect(answer).toEqual({ ok: true, href: `/chat/c/${CHANNEL}?activity=${SESSION}` });
        expect(state.notified).toEqual([FRIEND]);
        expect(state.limitKeys).toEqual(["arcade-invite:user-1"]);
    });

    it("refuses an input that does not fit before anything else", async () => {
        expect(await actions.inviteToGame({ game: "new-york" })).toEqual({
            ok: false,
            reason: "invalid"
        });
        expect(state.limitKeys).toEqual([]);
    });

    it("refuses without arcade.calls, without the app, or a game it does not offer", async () => {
        state.can = new Set();
        expect(await actions.inviteToGame({ game: "new-york", channelId: CHANNEL })).toEqual({
            ok: false,
            reason: "denied"
        });
        state.can = new Set(["arcade.calls"]);
        expect(await actions.inviteToGame({ game: "other-game", channelId: CHANNEL })).toEqual({
            ok: false,
            reason: "missing"
        });
        state.installed = false;
        expect(await actions.inviteToGame({ game: "new-york", channelId: CHANNEL })).toEqual({
            ok: false,
            reason: "missing"
        });
        expect(state.notified).toEqual([]);
    });

    it("stops at the rate limit, sending nothing", async () => {
        state.limited = true;
        expect(await actions.inviteToGame({ game: "new-york", userIds: [FRIEND] })).toEqual({
            ok: false,
            reason: "limited"
        });
        expect(state.notified).toEqual([]);
    });

    it("refuses a conversation the reader is not in", async () => {
        state.member = false;
        expect(await actions.inviteToGame({ game: "new-york", channelId: CHANNEL })).toEqual({
            ok: false,
            reason: "conversation"
        });
    });
});

describe("reading the card", () => {
    it("shows the game, who plays, and Join for somebody who may", async () => {
        const view = await actions.readActivityCard(SESSION);
        expect(view).toMatchObject({
            gameName: "New York",
            playing: 1,
            ended: false,
            inGame: true,
            refusal: null,
            startedBy: { id: "user-1", name: "Fixture Host" }
        });
    });

    it("refuses Join with the reason for somebody without arcade.calls", async () => {
        state.can = new Set();
        expect((await actions.readActivityCard(SESSION))?.refusal).toBe("denied");
    });

    it("says ended once nobody is left", async () => {
        state.session = {
            ...state.session,
            createdAt: new Date(Date.now() - 3_600_000),
            players: [{ userId: "user-1", seenAt: new Date(), leftAt: new Date() }]
        };
        const view = await actions.readActivityCard(SESSION);
        expect(view).toMatchObject({ ended: true, refusal: "ended", players: [] });
    });

    it("shows nothing outside its conversation or for a bad id", async () => {
        state.member = false;
        expect(await actions.readActivityCard(SESSION)).toBeNull();
        state.member = true;
        expect(await actions.readActivityCard("nope")).toBeNull();
    });
});
