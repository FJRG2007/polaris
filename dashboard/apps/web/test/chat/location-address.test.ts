/**
 * The street address over a location's full map: read by the server from the
 * message (never a point the page sends), only for a member of the
 * conversation, kept so a spot is asked once, and asked of Nominatim no faster
 * than once a second from the whole instance.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const CHANNEL = "0190a0b0-0000-7000-8000-000000000001";
const SEVILLA = "0190a0b0-0000-7000-8000-0000000000a1";
const MADRID = "0190a0b0-0000-7000-8000-0000000000a2";
const TEXT = "0190a0b0-0000-7000-8000-0000000000a3";
const MEMBER = { id: "member" };
const STRANGER = { id: "stranger" };

const points: Record<string, { latitude: number; longitude: number }> = {
    [SEVILLA]: { latitude: 37.30694, longitude: -4.67236 },
    [MADRID]: { latitude: 40.4168, longitude: -3.7038 }
};
const asked: { url: URL; at: number }[] = [];

class FakeError extends Error {}

vi.mock("@/lib/chat/access", () => ({
    ChatAccessError: FakeError,
    ChatRuleError: FakeError,
    requireChannel: async (actor: { id: string }) => {
        if (actor.id !== MEMBER.id) throw new FakeError("not a member");
        return {};
    },
    channelAccess: async () => null
}));
vi.mock("@/lib/chat/live", () => ({ publishChatChange: () => undefined }));
vi.mock("@/lib/chat/history-visibility", () => ({ requireReadable: async () => undefined }));
vi.mock("@/lib/safe-fetch", () => ({
    follow: async (url: URL) => {
        asked.push({ url, at: Date.now() });
        return { ok: true };
    },
    readCapped: async () =>
        new TextEncoder().encode(
            JSON.stringify({
                name: "",
                address: {
                    road: "Caserío del Camino la Manga",
                    house_number: "7",
                    postcode: "41570",
                    town: "Badolatosa",
                    province: "Sevilla",
                    state: "Andalucía",
                    country: "España"
                }
            })
        )
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        chatMessage: {
            findUnique: async ({ where }: { where: { id: string } }) =>
                where.id === SEVILLA || where.id === MADRID || where.id === TEXT
                    ? { channelId: CHANNEL, deletedAt: null }
                    : null
        },
        chatLocation: {
            findMany: async ({ where }: { where: { messageId: { in: string[] } } }) =>
                where.messageId.in
                    .filter((id) => points[id])
                    .map((id) => ({
                        messageId: id,
                        mode: "pin",
                        ...points[id],
                        accuracy: null,
                        placeName: null,
                        address: null,
                        liveUntil: null,
                        endedAt: null,
                        movedAt: new Date()
                    }))
        }
    }
}));

const locations = await import("@/lib/chat/locations");

beforeEach(() => {
    asked.length = 0;
});

describe("the address of a location message", () => {
    it("reads the point from the message and heads the map with street and town", async () => {
        const address = await locations.addressOf(MEMBER, SEVILLA, "es");
        expect(address).toEqual({ title: "Caserío del Camino la Manga, 7", subtitle: "41570 Badolatosa Sevilla" });
        expect(asked).toHaveLength(1);
        const url = asked[0]!.url;
        expect(url.host).toBe("nominatim.openstreetmap.org");
        expect(url.searchParams.get("lat")).toBe("37.3069");
        expect(url.searchParams.get("lon")).toBe("-4.6724");
    });

    it("keeps the answer, so the same spot is never asked twice", async () => {
        await locations.addressOf(MEMBER, SEVILLA, "es");
        await locations.addressOf(MEMBER, SEVILLA, "es");
        expect(asked).toHaveLength(0);
    });

    it("refuses somebody outside the conversation before anything is asked", async () => {
        await expect(locations.addressOf(STRANGER, MADRID, "es")).rejects.toThrow("not a member");
        expect(asked).toHaveLength(0);
    });

    it("says nothing for a message that is not a location", async () => {
        expect(await locations.addressOf(MEMBER, TEXT, "es")).toBeUndefined();
        expect(await locations.addressOf(MEMBER, "0190a0b0-0000-7000-8000-0000000000ff", "es")).toBeUndefined();
        expect(asked).toHaveLength(0);
    });

    it("asks the service no faster than once a second, and once for readers opening together", async () => {
        const [first, second] = await Promise.all([
            locations.addressOf(MEMBER, MADRID, "es"),
            locations.addressOf(MEMBER, MADRID, "es")
        ]);
        expect(first).toEqual(second);
        expect(asked).toHaveLength(1);
        await locations.addressOf(MEMBER, MADRID, "en");
        expect(asked).toHaveLength(2);
        expect(asked[1]!.at - asked[0]!.at).toBeGreaterThanOrEqual(1_000);
    });
});

describe("addressOfAnswer", () => {
    it("falls back to the place's name, then the town", () => {
        expect(locations.addressOfAnswer({ name: "Plaza Mayor", address: { city: "Madrid", state: "Madrid" } })).toEqual({
            title: "Plaza Mayor",
            subtitle: "Madrid"
        });
        expect(locations.addressOfAnswer({ address: { village: "Badolatosa", province: "Sevilla" } })).toEqual({
            title: "Badolatosa",
            subtitle: "Sevilla"
        });
        expect(locations.addressOfAnswer({})).toBeNull();
    });
});
