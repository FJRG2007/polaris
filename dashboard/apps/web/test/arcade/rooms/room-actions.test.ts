/**
 * Game rooms as the server decides them: opened only by somebody who may play
 * with others, joined by a code that is rate limited and admits nobody into a
 * full or finished room, listed publicly only while live, and played through
 * the lobby's own checks - a public room for anybody, a private one only for
 * whoever typed its code or was invited.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.unmock("@/app/(app)/chat/room-actions");
vi.unmock("@/app/(app)/chat/lobby-actions");

const ROOM = "0192f6a0-0000-7000-8000-0000000000bb";
const HOST = "0192f6a0-0000-7000-8000-0000000000dd";

interface Row {
    userId: string;
    joinedAt: Date;
    seenAt: Date;
    leftAt: Date | null;
}

const state = vi.hoisted(() => ({
    can: new Set<string>(),
    installed: true,
    limited: false,
    limitKeys: [] as string[],
    opened: [] as { game: string; isPublic: boolean; code: string }[],
    granted: [] as string[],
    invited: false,
    room: null as null | {
        id: string;
        code: string | null;
        isPublic: boolean;
        channelId: string | null;
        players: Row[];
        createdAt: Date;
    },
    listed: [] as unknown[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        user: {
            findMany: async () => [
                { id: "0192f6a0-0000-7000-8000-0000000000dd", name: "Fixture Host" }
            ]
        }
    }
}));
vi.mock("@/lib/session", () => ({
    requireUser: async () => ({ id: "user-1", name: "Fixture Player" }),
    sessionCan: async (_user: unknown, permission: string) => state.can.has(permission)
}));
vi.mock("@/lib/rate-limit-service", () => ({
    rateLimit: async (key: string) => {
        state.limitKeys.push(key);
        return { ok: !state.limited, retryAfterMs: 0 };
    }
}));
vi.mock("@/lib/i18n/locale-service", () => ({ getUserLocale: async () => "en-US" }));
vi.mock("@/lib/apps/install-presence", () => ({ isAppInstalled: async () => state.installed }));
vi.mock("@/lib/app-extensions/registry", () => ({
    callActivityGames: async () => [{ id: "new-york", name: "Skyline Roam", src: "/x" }]
}));
vi.mock("@/lib/chat/access", () => ({
    requireChannel: async () => {
        throw new Error("not a member");
    }
}));
vi.mock("@/lib/chat/call-server", () => ({
    callServer: async () => ({ url: "wss://media.example.test" }),
    lobbyToken: async () => "fixture-token"
}));
vi.mock("@/lib/chat/activity-sessions", () => ({
    openRoom: async (game: string, _by: string, isPublic: boolean, draw: () => string) => {
        const code = draw();
        state.opened.push({ game, isPublic, code });
        return { id: ROOM, channelId: null, game, messageId: null, code };
    },
    roomByCode: async (code: string) =>
        state.room && state.room.code === code ? { id: state.room.id, game: "new-york" } : null,
    sessionForCard: async () =>
        state.room
            ? {
                  ...state.room,
                  meetingId: null,
                  game: "new-york",
                  messageId: null,
                  startedById: HOST,
                  endedAt: null
              }
            : null,
    grantRoom: async (_id: string, userId: string) => {
        state.granted.push(userId);
    },
    holdsInvite: async () => state.invited,
    publicRooms: async () => state.listed
}));

import * as rooms from "@/app/(app)/chat/room-actions";
import { MAX_PLAYERS } from "@/lib/chat/call-activity";
import * as lobby from "@/app/(app)/chat/lobby-actions";
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } from "@/lib/arcade/room-code";

const now = () => new Date();
const playing = (count: number): Row[] =>
    Array.from({ length: count }, (_, index) => ({
        userId: `player-${index}`,
        joinedAt: now(),
        seenAt: now(),
        leftAt: null
    }));
const gone = (): Row[] => [{ userId: "player-0", joinedAt: now(), seenAt: now(), leftAt: now() }];

beforeEach(() => {
    state.can = new Set(["arcade.open", "arcade.calls"]);
    state.installed = true;
    state.limited = false;
    state.limitKeys = [];
    state.opened = [];
    state.granted = [];
    state.invited = false;
    state.room = {
        id: ROOM,
        code: "ABCD2345",
        isPublic: false,
        channelId: null,
        players: playing(1),
        createdAt: now()
    };
    state.listed = [];
});

describe("creating a room", () => {
    it("opens one under a fresh code and sends the opener to it", async () => {
        const answer = await rooms.createGameRoom({ game: "new-york", isPublic: true });
        expect(answer).toEqual({ ok: true, href: `/chat/play/${ROOM}` });
        const [opened] = state.opened;
        expect(opened).toMatchObject({ game: "new-york", isPublic: true });
        expect(opened!.code).toHaveLength(ROOM_CODE_LENGTH);
        expect([...opened!.code].every((char) => ROOM_CODE_ALPHABET.includes(char))).toBe(true);
        expect(state.limitKeys).toEqual(["arcade-room-open:user-1"]);
    });

    it("draws a different code each time", async () => {
        for (let index = 0; index < 20; index += 1)
            await rooms.createGameRoom({ game: "new-york", isPublic: false });
        expect(new Set(state.opened.map((room) => room.code)).size).toBe(20);
    });

    it("is refused without permission to play with others, before anything is opened", async () => {
        state.can.delete("arcade.calls");
        expect(await rooms.createGameRoom({ game: "new-york", isPublic: false })).toEqual({
            ok: false,
            reason: "denied"
        });
        state.can = new Set(["arcade.calls"]);
        expect(await rooms.createGameRoom({ game: "new-york", isPublic: false })).toEqual({
            ok: false,
            reason: "denied"
        });
        expect(state.opened).toEqual([]);
    });

    it("refuses a game not offered, a malformed input, and too many rooms", async () => {
        expect(await rooms.createGameRoom({ game: "chess", isPublic: false })).toMatchObject({
            reason: "missing"
        });
        expect(await rooms.createGameRoom({ game: "new-york" })).toMatchObject({
            reason: "invalid"
        });
        expect(
            await rooms.createGameRoom({ game: "new-york", isPublic: false, extra: 1 })
        ).toMatchObject({ reason: "invalid" });
        state.limited = true;
        expect(await rooms.createGameRoom({ game: "new-york", isPublic: false })).toMatchObject({
            reason: "limited"
        });
        expect(state.opened).toEqual([]);
    });
});

describe("joining by code", () => {
    it("takes the code as typed - lower case, a dash, spaces - and lets the reader in", async () => {
        expect(await rooms.joinGameRoom({ code: " abcd-2345 " })).toEqual({
            ok: true,
            href: `/chat/play/${ROOM}`
        });
        expect(state.granted).toEqual(["user-1"]);
        expect(state.limitKeys).toEqual(["arcade-room-code:user-1"]);
    });

    it("reads letters people mistype for digits as the digits", () => {
        expect(normalizeRoomCode("abcd-oil5")).toBe("ABCD0115");
    });

    it("says the same for a wrong code and a finished room, and grants nothing", async () => {
        expect(await rooms.joinGameRoom({ code: "ZZZZ2345" })).toEqual({
            ok: false,
            reason: "unknown"
        });
        state.room!.players = gone();
        expect(await rooms.joinGameRoom({ code: "ABCD2345" })).toEqual({
            ok: false,
            reason: "unknown"
        });
        expect(state.granted).toEqual([]);
    });

    it("refuses a full room", async () => {
        state.room!.players = playing(MAX_PLAYERS);
        expect(await rooms.joinGameRoom({ code: "ABCD2345" })).toEqual({
            ok: false,
            reason: "full"
        });
        expect(state.granted).toEqual([]);
    });

    it("stops at the limit before looking the code up", async () => {
        state.limited = true;
        expect(await rooms.joinGameRoom({ code: "ABCD2345" })).toEqual({
            ok: false,
            reason: "limited"
        });
        expect(state.granted).toEqual([]);
    });

    it("refuses a malformed code and a missing permission", async () => {
        expect(await rooms.joinGameRoom({ code: "ABC" })).toMatchObject({ reason: "invalid" });
        expect(await rooms.joinGameRoom({ code: "UUUU2345" })).toMatchObject({
            reason: "invalid"
        });
        expect(await rooms.joinGameRoom({})).toMatchObject({ reason: "invalid" });
        state.can.delete("arcade.open");
        expect(await rooms.joinGameRoom({ code: "ABCD2345" })).toMatchObject({
            reason: "denied"
        });
        expect(state.limitKeys).toEqual([]);
    });
});

describe("the public rooms", () => {
    const listed = (players: Row[], game = "new-york") => ({
        id: ROOM,
        game,
        startedById: HOST,
        createdAt: now(),
        endedAt: null,
        players
    });

    it("lists a live room of a game the reader can play, with its host and seats", async () => {
        state.listed = [listed(playing(2))];
        expect(await rooms.publicGameRooms()).toEqual({
            ok: true,
            rooms: [
                {
                    id: ROOM,
                    game: "new-york",
                    gameName: "Skyline Roam",
                    host: { id: HOST, name: "Fixture Host" },
                    players: 2,
                    max: MAX_PLAYERS,
                    href: `/chat/play/${ROOM}`
                }
            ]
        });
    });

    it("leaves out a full room, a finished one and one of a game not offered", async () => {
        state.listed = [listed(playing(MAX_PLAYERS)), listed(gone()), listed(playing(1), "chess")];
        expect(await rooms.publicGameRooms()).toEqual({ ok: true, rooms: [] });
    });

    it("is refused to somebody who may not play with others", async () => {
        state.can.delete("arcade.calls");
        expect(await rooms.publicGameRooms()).toEqual({ ok: false, reason: "denied" });
        state.installed = false;
        expect(await rooms.publicGameRooms()).toEqual({ ok: false, reason: "missing" });
    });
});

describe("playing in a room", () => {
    it("lets anybody into a public room, with its code to share", async () => {
        state.room!.isPublic = true;
        expect(await lobby.enterLobby(ROOM)).toMatchObject({
            ok: true,
            channelId: null,
            member: false,
            room: { code: "ABCD2345", isPublic: true }
        });
    });

    it("keeps a stranger out of a private room, and lets in whoever holds the code", async () => {
        expect(await lobby.enterLobby(ROOM)).toEqual({ ok: false, reason: "access" });
        state.invited = true;
        expect(await lobby.enterLobby(ROOM)).toMatchObject({ ok: true });
    });

    it("refuses a seat in a full room", async () => {
        state.room!.isPublic = true;
        state.room!.players = playing(MAX_PLAYERS);
        expect(await lobby.enterLobby(ROOM)).toEqual({ ok: false, reason: "full" });
    });
});
