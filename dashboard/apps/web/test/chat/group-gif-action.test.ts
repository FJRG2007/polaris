/** Putting a GIF on a group: the input is checked, and so is who is asking. */

import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
    allowed: true,
    stored: [] as string[],
    bytes: new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 1, 0, 1, 0])
}));

vi.mock("@/lib/session", () => ({
    requirePermission: async () => ({ id: "ada", name: "Ada" })
}));
vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/chat/picture-access", () => ({
    mayChangeChatPicture: async () => fake.allowed
}));
vi.mock("@/lib/chat/tenor", () => ({
    fetchRemoteMedia: async () => ({ name: "a.gif", type: "image/gif", bytes: fake.bytes }),
    searchTenor: async () => [],
    tenorConfigured: async () => true
}));
vi.mock("@/lib/avatar-service", async () => {
    const actual = await vi.importActual<Record<string, unknown>>("@/lib/avatar-service");
    return {
        ...actual,
        storeAvatar: async (subject: { id: string }) => void fake.stored.push(subject.id)
    };
});

import { setGroupGifAction } from "@/app/(app)/chat/actions";

beforeEach(() => {
    fake.allowed = true;
    fake.stored = [];
});

describe("setGroupGifAction", () => {
    it("refuses an input that is not a channel and an address", async () => {
        for (const input of [null, {}, { channelId: "c1" }, { channelId: "c1", address: "no" }]) {
            expect((await setGroupGifAction(input)).error).toBeTruthy();
        }
        expect(fake.stored).toEqual([]);
    });

    it("refuses somebody the picture is not theirs to change", async () => {
        fake.allowed = false;
        const result = await setGroupGifAction({
            channelId: "c1",
            address: "https://x.test/a.gif"
        });
        expect(result.error).toBe("You cannot change this group's icon");
        expect(fake.stored).toEqual([]);
    });

    it("stores the GIF for somebody who may", async () => {
        const result = await setGroupGifAction({
            channelId: "c1",
            address: "https://x.test/a.gif"
        });
        expect(result).toEqual({});
        expect(fake.stored).toEqual(["c1"]);
    });
});
