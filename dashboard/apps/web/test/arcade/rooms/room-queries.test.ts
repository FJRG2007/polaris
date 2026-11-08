/**
 * The room queries themselves, against the database calls they make: a taken
 * code is drawn again and anything else is thrown, a code typed in renews the
 * reader's own invitation, and the public list asks only for rooms somebody is
 * still in or that opened too recently for anybody to have sat down.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    create: vi.fn(),
    upsert: vi.fn(),
    findMany: vi.fn()
}));

vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@polaris/db", () => ({
    prisma: {
        arcadeSession: { create: db.create, findMany: db.findMany },
        arcadeInvite: { upsert: db.upsert }
    }
}));

import { PASS_TTL_MS } from "@/lib/chat/call-activity";
import { INVITE_TTL_MS, INVITE_WAIT_MS } from "@/lib/chat/activity-card";
import { grantRoom, openRoom, publicRooms, PUBLIC_ROOMS_MAX } from "@/lib/chat/activity-sessions";

const ROOM = "0192f6a0-0000-7000-8000-0000000000bb";
const HOST = "0192f6a0-0000-7000-8000-0000000000dd";
const NOW = Date.UTC(2026, 10, 8, 12);

const taken = () => Object.assign(new Error("Unique constraint failed"), { code: "P2002" });

beforeEach(() => {
    db.create.mockReset();
    db.upsert.mockReset();
    db.findMany.mockReset();
});

describe("openRoom", () => {
    it("opens a room with no meeting and no conversation under the drawn code", async () => {
        db.create.mockResolvedValueOnce({
            id: ROOM,
            channelId: null,
            game: "chess",
            messageId: null
        });

        const room = await openRoom("chess", HOST, true, () => "ABCD2345");

        expect(room).toEqual({
            id: ROOM,
            channelId: null,
            game: "chess",
            messageId: null,
            code: "ABCD2345"
        });
        expect(db.create).toHaveBeenCalledWith(
            expect.objectContaining({
                data: {
                    meetingId: null,
                    channelId: null,
                    game: "chess",
                    startedById: HOST,
                    code: "ABCD2345",
                    isPublic: true
                }
            })
        );
    });

    it("draws a new code when the one drawn is taken", async () => {
        db.create
            .mockRejectedValueOnce(taken())
            .mockRejectedValueOnce(taken())
            .mockResolvedValueOnce({ id: ROOM, channelId: null, game: "chess", messageId: null });
        const codes = ["AAAA1111", "BBBB2222", "CCCC3333"];

        const room = await openRoom("chess", HOST, false, () => codes.shift()!);

        expect(room.code).toBe("CCCC3333");
        expect(db.create.mock.calls.map(([call]) => call.data.code)).toEqual([
            "AAAA1111",
            "BBBB2222",
            "CCCC3333"
        ]);
    });

    it("gives up after five taken codes", async () => {
        db.create.mockRejectedValue(taken());
        let drawn = 0;

        await expect(openRoom("chess", HOST, false, () => `CODE${++drawn}`)).rejects.toMatchObject({
            code: "P2002"
        });
        expect(db.create).toHaveBeenCalledTimes(5);
    });

    it("throws any other failure at once, without drawing again", async () => {
        db.create.mockRejectedValueOnce(new Error("connection lost"));
        const draw = vi.fn(() => "ABCD2345");

        await expect(openRoom("chess", HOST, false, draw)).rejects.toThrow("connection lost");
        expect(draw).toHaveBeenCalledTimes(1);
        expect(db.create).toHaveBeenCalledTimes(1);
    });
});

describe("grantRoom", () => {
    it("issues the reader's own invitation, or renews and undeclines the one they hold", async () => {
        db.upsert.mockResolvedValueOnce({});

        await grantRoom(ROOM, HOST, NOW);

        const expiresAt = new Date(NOW + INVITE_TTL_MS);
        expect(db.upsert).toHaveBeenCalledWith({
            where: { sessionId_userId: { sessionId: ROOM, userId: HOST } },
            create: { sessionId: ROOM, userId: HOST, invitedById: HOST, expiresAt },
            update: { expiresAt, declinedAt: null }
        });
    });
});

describe("publicRooms", () => {
    it("asks only for running public rooms someone is in or that just opened, newest first", async () => {
        db.findMany.mockResolvedValueOnce([]);

        await publicRooms(NOW);

        const [query] = db.findMany.mock.calls[0];
        expect(query.where).toEqual({
            isPublic: true,
            meetingId: null,
            endedAt: null,
            OR: [
                {
                    players: {
                        some: { leftAt: null, seenAt: { gt: new Date(NOW - PASS_TTL_MS) } }
                    }
                },
                { createdAt: { gt: new Date(NOW - INVITE_WAIT_MS) }, players: { none: {} } }
            ]
        });
        expect(query.orderBy).toEqual({ createdAt: "desc" });
        expect(query.take).toBe(PUBLIC_ROOMS_MAX);
    });

    it("returns what the database answered", async () => {
        const rows = [{ id: ROOM, game: "chess", players: [] }];
        db.findMany.mockResolvedValueOnce(rows);

        expect(await publicRooms(NOW)).toBe(rows);
    });
});
