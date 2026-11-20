/**
 * Location messages: what may be sent, how a live share reads back, and the
 * privacy half - moves after the end, or into a room the sender left, are never
 * written, and only the sender stops a share.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatLocationSendSchema, liveLocationRunning, geoPointSchema } from "@polaris/core";

const CHANNEL = "0190a0b0-0000-7000-8000-000000000001";
const OTHER_CHANNEL = "0190a0b0-0000-7000-8000-000000000002";
const MESSAGE = "0190a0b0-0000-7000-8000-0000000000a1";
const MESSAGE_2 = "0190a0b0-0000-7000-8000-0000000000a2";

interface Share {
    messageId: string;
    channelId: string;
    authorId: string;
    movedAt: Date;
    liveUntil: Date;
    endedAt: Date | null;
}

let shares: Share[] = [];
let reachable = new Set<string>();
const updates: { where: Record<string, unknown>; data: Record<string, unknown> }[] = [];
const published: unknown[] = [];

class FakeError extends Error {}

vi.mock("@/lib/chat/access", () => ({
    ChatAccessError: FakeError,
    ChatRuleError: FakeError,
    requireChannel: async () => ({}),
    channelAccess: async (_actor: unknown, channelId: string) => (reachable.has(channelId) ? { channelId } : null)
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: (change: unknown) => published.push(change) }));
vi.mock("@/lib/chat/history-visibility", () => ({ requireReadable: async () => undefined }));
vi.mock("@/lib/safe-fetch", () => ({ follow: async () => null, readCapped: async () => null }));

function running(now: Date, authorId: string) {
    return shares.filter((share) => share.authorId === authorId && share.endedAt === null && share.liveUntil > now);
}

vi.mock("@polaris/db", () => ({
    prisma: {
        chatLocation: {
            findMany: async ({ where }: { where: { liveUntil: { gt: Date }; message: { authorId: string } } }) =>
                running(where.liveUntil.gt, where.message.authorId).map((share) => ({
                    messageId: share.messageId,
                    movedAt: share.movedAt,
                    liveUntil: share.liveUntil,
                    message: { channelId: share.channelId }
                })),
            updateMany: async (args: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
                updates.push(args);
                return { count: 0 };
            }
        },
        chatMessage: {
            findUnique: async ({ where }: { where: { id: string } }) => {
                const share = shares.find((one) => one.messageId === where.id);
                return share ? { authorId: share.authorId, channelId: share.channelId, location: { mode: "live" } } : null;
            }
        }
    }
}));

const locations = await import("@/lib/chat/locations");

const NOW = new Date("2026-11-20T12:00:00Z");
const point = { latitude: 40.4168, longitude: -3.7038, accuracy: 12 };

beforeEach(() => {
    shares = [];
    reachable = new Set([CHANNEL, OTHER_CHANNEL]);
    updates.length = 0;
    published.length = 0;
});

describe("what may be sent", () => {
    it("takes each mode with exactly what it needs", () => {
        expect(chatLocationSendSchema.safeParse({ mode: "pin", channelId: CHANNEL, point }).success).toBe(true);
        expect(chatLocationSendSchema.safeParse({ mode: "request", channelId: CHANNEL }).success).toBe(true);
        expect(
            chatLocationSendSchema.safeParse({ mode: "place", channelId: CHANNEL, point, name: "Cafe" }).success
        ).toBe(true);
        expect(chatLocationSendSchema.safeParse({ mode: "place", channelId: CHANNEL, point, name: " " }).success).toBe(
            false
        );
        expect(chatLocationSendSchema.safeParse({ mode: "pin", channelId: CHANNEL }).success).toBe(false);
    });

    it("offers only WhatsApp's three live lengths", () => {
        for (const minutes of [15, 60, 480]) {
            expect(chatLocationSendSchema.safeParse({ mode: "live", channelId: CHANNEL, point, minutes }).success).toBe(
                true
            );
        }
        expect(chatLocationSendSchema.safeParse({ mode: "live", channelId: CHANNEL, point, minutes: 30 }).success).toBe(
            false
        );
        expect(
            chatLocationSendSchema.safeParse({ mode: "live", channelId: CHANNEL, point, minutes: 15 * 60 * 24 }).success
        ).toBe(false);
    });

    it("refuses a point off the planet and drops a nonsense accuracy", () => {
        expect(geoPointSchema.safeParse({ latitude: 91, longitude: 0 }).success).toBe(false);
        expect(geoPointSchema.safeParse({ latitude: 0, longitude: 181 }).success).toBe(false);
        expect(geoPointSchema.parse({ latitude: 1, longitude: 2, accuracy: -5 }).accuracy).toBeNull();
    });
});

describe("how a live share reads back", () => {
    it("runs until its clock or its sender stops it", () => {
        const later = new Date(NOW.getTime() + 60_000);
        expect(liveLocationRunning({ liveUntil: later, endedAt: null }, NOW)).toBe(true);
        expect(liveLocationRunning({ liveUntil: NOW, endedAt: null }, NOW)).toBe(false);
        expect(liveLocationRunning({ liveUntil: later, endedAt: NOW }, NOW)).toBe(false);
        expect(liveLocationRunning({ liveUntil: null, endedAt: null }, NOW)).toBe(false);
    });

    it("says ended on a card whose time ran out", () => {
        const view = locations.viewOf(
            {
                messageId: MESSAGE,
                mode: "live",
                latitude: 1,
                longitude: 2,
                accuracy: null,
                placeName: null,
                address: null,
                liveUntil: new Date(NOW.getTime() - 1),
                endedAt: null,
                movedAt: NOW
            },
            NOW
        );
        expect(view.live).toBe(false);
        expect(view.endedEarly).toBe(false);
    });
});

describe("moving a live share", () => {
    it("moves every running share at once and announces each room", async () => {
        shares = [
            { messageId: MESSAGE, channelId: CHANNEL, authorId: "me", movedAt: new Date(0), liveUntil: new Date(NOW.getTime() + 60_000), endedAt: null },
            { messageId: MESSAGE_2, channelId: OTHER_CHANNEL, authorId: "me", movedAt: new Date(0), liveUntil: new Date(NOW.getTime() + 60_000), endedAt: null }
        ];
        const result = await locations.moveLive({ id: "me" }, point, NOW);
        expect(result).toEqual({ running: 2, moved: 2 });
        expect(updates[0]?.where).toMatchObject({ endedAt: null, liveUntil: { gt: NOW } });
        expect(updates[0]?.data).toMatchObject({ latitude: point.latitude, longitude: point.longitude });
        expect(published).toHaveLength(2);
    });

    it("writes nothing once the share has run out", async () => {
        shares = [
            { messageId: MESSAGE, channelId: CHANNEL, authorId: "me", movedAt: new Date(0), liveUntil: new Date(NOW.getTime() - 1), endedAt: null }
        ];
        expect(await locations.moveLive({ id: "me" }, point, NOW)).toEqual({ running: 0, moved: 0 });
        expect(updates).toHaveLength(0);
    });

    it("ends a share in a room the sender can no longer reach instead of moving it", async () => {
        reachable = new Set([CHANNEL]);
        shares = [
            { messageId: MESSAGE_2, channelId: OTHER_CHANNEL, authorId: "me", movedAt: new Date(0), liveUntil: new Date(NOW.getTime() + 60_000), endedAt: null }
        ];
        const result = await locations.moveLive({ id: "me" }, point, NOW);
        expect(result.running).toBe(0);
        expect(updates[0]?.data).toEqual({ endedAt: NOW });
    });

    it("ignores a move that comes too soon after the last", async () => {
        shares = [
            { messageId: MESSAGE, channelId: CHANNEL, authorId: "me", movedAt: new Date(NOW.getTime() - 1_000), liveUntil: new Date(NOW.getTime() + 60_000), endedAt: null }
        ];
        expect(await locations.moveLive({ id: "me" }, point, NOW)).toEqual({ running: 1, moved: 0 });
        expect(updates).toHaveLength(0);
    });
});

describe("stopping a live share", () => {
    it("lets only the sender stop it", async () => {
        shares = [
            { messageId: MESSAGE, channelId: CHANNEL, authorId: "someone", movedAt: NOW, liveUntil: new Date(NOW.getTime() + 60_000), endedAt: null }
        ];
        await expect(locations.stopLive({ id: "me" }, MESSAGE, NOW)).rejects.toBeInstanceOf(FakeError);
        expect(updates).toHaveLength(0);
    });

    it("stops every share when none is named", async () => {
        shares = [
            { messageId: MESSAGE, channelId: CHANNEL, authorId: "me", movedAt: NOW, liveUntil: new Date(NOW.getTime() + 60_000), endedAt: null },
            { messageId: MESSAGE_2, channelId: OTHER_CHANNEL, authorId: "me", movedAt: NOW, liveUntil: new Date(NOW.getTime() + 60_000), endedAt: null }
        ];
        await locations.stopLive({ id: "me" }, null, NOW);
        expect(updates[0]?.data).toEqual({ endedAt: NOW });
        expect(published).toHaveLength(2);
    });
});

describe("places nearby", () => {
    it("lists the nearest first, with a distance", () => {
        const from = { latitude: 40.4168, longitude: -3.7038 };
        const places = locations.placesOf(
            [
                { lat: 40.43, lon: -3.7038, name: "Far", display_name: "Far, Madrid" },
                { lat: 40.417, lon: -3.7038, name: "", display_name: "Near Cafe, Calle Mayor, Madrid" }
            ],
            from
        );
        expect(places.map((place) => place.name)).toEqual(["Near Cafe", "Far"]);
        expect(places[0]?.meters).toBeLessThan(50);
    });

    it("measures a degree of latitude as about 111 km", () => {
        const meters = locations.metersBetween({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 });
        expect(meters).toBeGreaterThan(110_000);
        expect(meters).toBeLessThan(112_000);
    });
});
