/**
 * Members the server runs reach a conversation only through what put them
 * there: Polar where somebody added it, a webhook in its own channel, the game
 * bridge where a game shows the conversation. And
 * `channelAccess` answers them from that, so the MLS route's checks on an
 * account hold for them as for a person.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
    channels: new Map<string, { id: string; kind: string; spaceId: string | null; archived: boolean; space: { archived: boolean } | null }>(),
    webhooks: [] as { channelId: string }[],
    services: new Map<string, { channelId: string; service: string; addedById: string | null }>(),
    /** Conversations an installed app shows to everybody playing. */
    shown: new Set<string>()
}));

vi.mock("@/lib/app-extensions/registry", async (original) => ({
    ...(await original<typeof import("@/lib/app-extensions/registry")>()),
    channelShownInGame: async (channelId: string) => db.shown.has(channelId)
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: { findUnique: async ({ where }: { where: { id: string } }) => db.channels.get(where.id) ?? null },
        chatWebhook: { count: async ({ where }: { where: { channelId: string } }) => db.webhooks.filter((w) => w.channelId === where.channelId).length },
        chatServiceMember: {
            findUnique: async ({ where }: { where: { channelId_service: { channelId: string; service: string } } }) =>
                db.services.get(`${where.channelId_service.channelId}:${where.channelId_service.service}`) ?? null,
            upsert: async ({ create }: { create: { channelId: string; service: string; addedById: string } }) => {
                const key = `${create.channelId}:${create.service}`;
                if (!db.services.has(key)) db.services.set(key, create);
            },
            deleteMany: async ({ where }: { where: { channelId: string; service: string } }) => {
                db.services.delete(`${where.channelId}:${where.service}`);
            }
        },
        chatChannelMember: { findUnique: async () => null }
    }
}));

const members = await import("@/lib/chat/service-members");
const { channelAccess } = await import("@/lib/chat/access");

const CHANNEL = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";

beforeEach(() => {
    db.channels.clear();
    db.webhooks = [];
    db.services.clear();
    db.shown.clear();
    db.channels.set(CHANNEL, { id: CHANNEL, kind: "group", spaceId: null, archived: false, space: null });
    db.channels.set(OTHER, { id: OTHER, kind: "text", spaceId: null, archived: true, space: null });
});

describe("service accounts", () => {
    it("are ids no person can have, and each runs one device per conversation or webhook", () => {
        expect(members.serviceKind(members.POLAR_SERVICE_ID)).toBe("polar");
        expect(members.serviceKind(members.WEBHOOK_SERVICE_ID)).toBe("webhook");
        expect(members.serviceKind(members.GAME_SERVICE_ID)).toBe("game");
        expect(members.GAME_SERVICE_ID[14]).toBe("0");
        expect(Object.values(members.SERVICE_ACCOUNTS)).toEqual([members.POLAR_SERVICE_ID, members.WEBHOOK_SERVICE_ID, members.GAME_SERVICE_ID]);
        expect(members.serviceKind("11111111-1111-4111-8111-111111111111")).toBeNull();
        // Version nibble 0: never a uuid(7) or a gen_random_uuid() (version 4).
        expect(members.POLAR_SERVICE_ID[14]).toBe("0");
        expect(members.serviceDevice(CHANNEL)).toBe("44444444444444448444444444444444");
    });
});

describe("Polar in a conversation", () => {
    it("reaches it only once somebody added it, and not after it was removed", async () => {
        const polar = { id: members.POLAR_SERVICE_ID };
        expect(await channelAccess(polar, CHANNEL)).toBeNull();
        await members.addPolar("ada", CHANNEL);
        await members.addPolar("grace", CHANNEL);
        expect(db.services.get(`${CHANNEL}:polar`)?.addedById).toBe("ada");
        expect(await members.polarAdded(CHANNEL)).toBe(true);
        const access = await channelAccess(polar, CHANNEL);
        expect(access).toMatchObject({ channelId: CHANNEL, mayPost: true, mayAdminister: false, mayModerate: false, member: false });
        expect(await channelAccess(polar, OTHER)).toBeNull();
        await members.removePolar(CHANNEL);
        expect(await channelAccess(polar, CHANNEL)).toBeNull();
    });

    it("cannot post where the conversation is archived", async () => {
        await members.addPolar("ada", OTHER);
        expect(await channelAccess({ id: members.POLAR_SERVICE_ID }, OTHER)).toMatchObject({ mayPost: false });
    });

    it("reaches no conversation that does not exist", async () => {
        await members.addPolar("ada", "66666666-6666-4666-8666-666666666666");
        expect(await channelAccess({ id: members.POLAR_SERVICE_ID }, "66666666-6666-4666-8666-666666666666")).toBeNull();
    });
});

describe("webhooks", () => {
    it("reach the channel a webhook belongs to and no other", async () => {
        const webhook = { id: members.WEBHOOK_SERVICE_ID };
        expect(await channelAccess(webhook, CHANNEL)).toBeNull();
        db.webhooks.push({ channelId: CHANNEL });
        expect(await channelAccess(webhook, CHANNEL)).not.toBeNull();
        expect(await channelAccess(webhook, OTHER)).toBeNull();
    });
});

describe("the game bridge", () => {
    it("reaches a conversation only while a game shows it, and may never post there", async () => {
        const bridge = { id: members.GAME_SERVICE_ID };
        expect(await channelAccess(bridge, CHANNEL)).toBeNull();
        db.shown.add(CHANNEL);
        expect(await members.serviceReaches("game", CHANNEL)).toBe(true);
        expect(await channelAccess(bridge, CHANNEL)).toMatchObject({ channelId: CHANNEL, mayPost: false, mayAdminister: false, member: false });
        expect(await channelAccess(bridge, OTHER)).toBeNull();
        db.shown.delete(CHANNEL);
        expect(await channelAccess(bridge, CHANNEL)).toBeNull();
    });

    it("is not Polar: a game showing a conversation does not add Polar, nor Polar the bridge", async () => {
        db.shown.add(CHANNEL);
        expect(await members.polarAdded(CHANNEL)).toBe(false);
        db.shown.clear();
        await members.addPolar("ada", CHANNEL);
        expect(await members.serviceReaches("game", CHANNEL)).toBe(false);
    });
});
