/**
 * The three switches that stop link previews (ledger row 4): instance,
 * conversation and author. All on by default, so nothing changes until one is
 * turned off.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let setting: string | null = null;
let quietRooms: string[] = [];
let quietAuthors: string[] = [];

vi.mock("@/lib/setting-store", () => ({
    getSetting: async () => setting,
    setSetting: async (_key: string, value: string | null) => {
        setting = value;
    }
}));
vi.mock("@polaris/db", () => ({
    prisma: {
        chatChannel: {
            findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
                where.id.in.filter((id) => quietRooms.includes(id)).map((id) => ({ id }))
        },
        userPrivacy: {
            findMany: async ({ where }: { where: { userId: { in: string[] } } }) =>
                where.userId.in
                    .filter((id) => quietAuthors.includes(id))
                    .map((userId) => ({ userId }))
        }
    }
}));

const policy = await import("@/lib/chat/link-preview-policy");

const rows = [
    { id: "m1", channelId: "c1", authorId: "ada" },
    { id: "m2", channelId: "c2", authorId: "alan" },
    { id: "m3", channelId: "c2", authorId: null }
];

beforeEach(() => {
    setting = null;
    quietRooms = [];
    quietAuthors = [];
});

describe("link preview switches", () => {
    it("withholds nothing while every switch is at its default", async () => {
        expect([...(await policy.previewsWithheld(rows))]).toEqual([]);
        expect(await policy.instancePreviewsAllowed()).toBe(true);
    });

    it("withholds everything when the instance turns them off", async () => {
        await policy.setInstancePreviews(false);
        expect([...(await policy.previewsWithheld(rows))].sort()).toEqual(["m1", "m2", "m3"]);
        await policy.setInstancePreviews(true);
        expect(setting).toBeNull();
    });

    it("withholds one conversation's messages", async () => {
        quietRooms = ["c2"];
        expect([...(await policy.previewsWithheld(rows))].sort()).toEqual(["m2", "m3"]);
    });

    it("withholds what one author sends, wherever they send it", async () => {
        quietAuthors = ["ada"];
        expect([...(await policy.previewsWithheld(rows))]).toEqual(["m1"]);
        expect(await policy.previewAllowed(rows[1]!)).toBe(true);
    });
});
