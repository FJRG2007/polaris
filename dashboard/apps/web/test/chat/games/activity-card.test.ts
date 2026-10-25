/**
 * The card a conversation shows for a game played in its call: how it is
 * found in a message, when a session counts as over, and why Join is refused.
 */

import { describe, expect, it } from "vitest";
import * as card from "@/lib/chat/activity-card";
import { MAX_PLAYERS, PASS_TTL_MS } from "@/lib/chat/call-activity";

const SESSION = "0192f6a0-0000-7000-8000-0000000000bb";
const NOW = 1_800_000_000_000;
const at = (ms: number) => new Date(NOW - ms);

describe("the card's mark", () => {
    it("round-trips a session id and ignores every other body", () => {
        expect(card.activityIdIn(card.activityMark(SESSION))).toBe(SESSION);
        expect(card.activityIdIn("fixture-user-a joined")).toBeNull();
        expect(card.activityIdIn("polaris-activity:not-a-uuid")).toBeNull();
        expect(card.activityIdIn(`polaris-activity:${SESSION} extra`)).toBeNull();
    });

    it("joins through the conversation with the session named", () => {
        expect(card.joinHref("chan-1", SESSION)).toBe(`/chat/c/chan-1?activity=${SESSION}`);
    });
});

describe("whether a session is over", () => {
    const player = (seenMs: number, left: number | null = null) => ({
        userId: "fixture-user-a",
        seenAt: at(seenMs),
        leftAt: left === null ? null : at(left)
    });

    it("is live while somebody renewed within a pass's life", () => {
        const facts = {
            createdAt: at(60_000),
            endedAt: null,
            callEnded: false,
            players: [player(1000)]
        };
        expect(card.sessionEnded(facts, NOW)).toBe(false);
    });

    it("ends when the last player left or went quiet past a pass", () => {
        const base = { createdAt: at(600_000), endedAt: null, callEnded: false };
        expect(card.sessionEnded({ ...base, players: [player(1000, 500)] }, NOW)).toBe(true);
        expect(card.sessionEnded({ ...base, players: [player(PASS_TTL_MS + 1)] }, NOW)).toBe(true);
    });

    it("ends with its call, or when closed", () => {
        const players = [player(1000)];
        expect(
            card.sessionEnded({ createdAt: at(1), endedAt: null, callEnded: true, players }, NOW)
        ).toBe(true);
        expect(
            card.sessionEnded({ createdAt: at(1), endedAt: at(0), callEnded: false, players }, NOW)
        ).toBe(true);
    });

    it("waits a few minutes for the first player of an invitation", () => {
        const fresh = { createdAt: at(10_000), endedAt: null, callEnded: false, players: [] };
        expect(card.sessionEnded(fresh, NOW)).toBe(false);
        const stale = { ...fresh, createdAt: at(card.INVITE_WAIT_MS + 1) };
        expect(card.sessionEnded(stale, NOW)).toBe(true);
    });
});

describe("why Join is refused", () => {
    const open = { ended: false, installed: true, mayPlay: true, playing: 2, inGame: false };

    it("lets in somebody who may play a running game with room", () => {
        expect(card.joinRefusal(open)).toBeNull();
    });

    it("says ended before anything about the reader", () => {
        expect(card.joinRefusal({ ...open, ended: true, mayPlay: false })).toBe("ended");
    });

    it("refuses without arcade.calls, or without the app", () => {
        expect(card.joinRefusal({ ...open, mayPlay: false })).toBe("denied");
        expect(card.joinRefusal({ ...open, installed: false })).toBe("missing");
    });

    it("refuses a full game, except to somebody already in it", () => {
        expect(card.joinRefusal({ ...open, playing: MAX_PLAYERS })).toBe("full");
        expect(card.joinRefusal({ ...open, playing: MAX_PLAYERS, inGame: true })).toBeNull();
    });
});

describe("the invitation's input", () => {
    const CHANNEL = "0192f6a0-0000-7000-8000-0000000000cc";
    const person = (n: number) => `0192f6a0-0000-7000-8000-0000000000${String(n).padStart(2, "0")}`;

    it("takes one conversation or up to nine people", () => {
        expect(
            card.inviteInputSchema.safeParse({ game: "new-york", channelId: CHANNEL }).success
        ).toBe(true);
        const nine = Array.from({ length: 9 }, (_, n) => person(n));
        expect(card.inviteInputSchema.safeParse({ game: "new-york", userIds: nine }).success).toBe(
            true
        );
    });

    it("refuses nobody, too many people, both at once, a bad game or extra fields", () => {
        const ten = Array.from({ length: 10 }, (_, n) => person(n));
        for (const input of [
            { game: "new-york", userIds: [] },
            { game: "new-york", userIds: ten },
            { game: "new-york", channelId: CHANNEL, userIds: [person(1)] },
            { game: "../etc", channelId: CHANNEL },
            { game: "new-york", channelId: "not-a-uuid" },
            { game: "new-york", channelId: CHANNEL, admin: true }
        ]) {
            expect(card.inviteInputSchema.safeParse(input).success).toBe(false);
        }
    });
});

describe("lobbies and invitations", () => {
    const at = (ms: number) => new Date(ms);

    it("counts a finished session from the first player in to the last one out", () => {
        const players = [
            { userId: "a", joinedAt: at(1_000), seenAt: at(5_000), leftAt: at(61_000) },
            { userId: "b", joinedAt: at(10_000), seenAt: at(30_000), leftAt: null }
        ];
        expect(card.sessionDuration(players, null)).toBe(60_000);
        expect(card.sessionDuration(players, at(31_000))).toBe(30_000);
        expect(card.sessionDuration([], null)).toBeNull();
    });

    it("offers an invitation only while it is open, not declined and its session runs", () => {
        const open = { expiresAt: at(10_000), declinedAt: null };
        expect(card.inviteOpen(open, false, 5_000)).toBe(true);
        expect(card.inviteOpen(open, false, 10_000)).toBe(false);
        expect(card.inviteOpen(open, true, 5_000)).toBe(false);
        expect(card.inviteOpen({ ...open, declinedAt: at(1) }, false, 5_000)).toBe(false);
    });

    it("keeps a lobby's room, page and passes apart from any call's", () => {
        const id = "0192f6a0-0000-7000-8000-0000000000bb";
        expect(card.lobbyHref(id)).toBe(`/chat/play/${id}`);
        expect(card.lobbyRoom(id)).not.toBe(id);
        expect(card.lobbyPassScope(id)).not.toBe(id);
        expect(card.sessionInviteSchema.safeParse({ sessionId: id, userIds: [] }).success).toBe(
            false
        );
    });
});
