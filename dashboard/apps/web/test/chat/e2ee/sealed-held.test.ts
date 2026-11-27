/**
 * A page while sealed chat is held by the kill switch (docs/chat-e2ee-mls.md,
 * "The kill switch"): a conversation sealed already keeps sealing what is sent
 * into it, any other one sends plain, and an unanswered question never turns
 * into a plain send.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

// What the server answers of a conversation: "sealed" has its group, "open" is a public channel, "plain" neither.
const device = vi.hoisted(() => ({
    sealingOf: vi.fn(async (channelId: string) => ({ sealed: channelId === "sealed", seals: channelId !== "open", open: channelId === "open" }))
}));

vi.mock("@/lib/chat/e2ee/mls-browser", () => ({ openBrowserDevice: async () => device }));
vi.mock("@/lib/chat/e2ee/account-key-client", () => ({ deviceAccountHpke: async () => null }));

import { configureSealedChat, sealsSendsIn } from "@/lib/chat/e2ee/sealed-chat";

afterEach(() => {
    configureSealedChat(null, { held: false });
    device.sealingOf.mockClear();
});

describe("sealsSendsIn", () => {
    it("seals nothing with sealed chat off and everything while it is on", async () => {
        expect(await sealsSendsIn("plain")).toBe(false);
        configureSealedChat("viewer-1", { held: false });
        expect(await sealsSendsIn("plain")).toBe(true);
        // A public channel (encryption-policy.ts) seals nothing new, also while sealed chat is on.
        expect(await sealsSendsIn("open")).toBe(false);
    });

    it("while held, seals only into a conversation sealed already, asking once", async () => {
        configureSealedChat("viewer-1", { held: true });
        expect(await sealsSendsIn("sealed")).toBe(true);
        expect(await sealsSendsIn("plain")).toBe(false);
        expect(await sealsSendsIn("sealed")).toBe(true);
        expect(device.sealingOf).toHaveBeenCalledTimes(2);
    });

    it("keeps the held state for a caller that does not name it", async () => {
        configureSealedChat("viewer-1", { held: true });
        configureSealedChat("viewer-1");
        expect(await sealsSendsIn("plain")).toBe(false);
    });

    it("throws rather than answering plain when it cannot tell", async () => {
        configureSealedChat("viewer-1", { held: true });
        device.sealingOf.mockRejectedValueOnce(new Error("offline"));
        await expect(sealsSendsIn("sealed")).rejects.toThrow("offline");
        expect(await sealsSendsIn("sealed")).toBe(true);
    });
});
