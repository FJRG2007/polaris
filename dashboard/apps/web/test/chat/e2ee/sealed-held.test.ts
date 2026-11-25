/**
 * A page while sealed chat is held by the kill switch (docs/chat-e2ee-mls.md,
 * "The kill switch"): a conversation sealed already keeps sealing what is sent
 * into it, any other one sends plain, and an unanswered question never turns
 * into a plain send.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({ sealedAlready: vi.fn(async (channelId: string) => channelId === "sealed") }));

vi.mock("@/lib/chat/e2ee/mls-browser", () => ({ openBrowserDevice: async () => device }));
vi.mock("@/lib/chat/e2ee/account-key-client", () => ({ deviceAccountHpke: async () => null }));

import { configureSealedChat, sealsSendsIn } from "@/lib/chat/e2ee/sealed-chat";

afterEach(() => {
    configureSealedChat(null, { held: false });
    device.sealedAlready.mockClear();
});

describe("sealsSendsIn", () => {
    it("seals nothing with sealed chat off and everything while it is on", async () => {
        expect(await sealsSendsIn("plain")).toBe(false);
        configureSealedChat("viewer-1", { held: false });
        expect(await sealsSendsIn("plain")).toBe(true);
        expect(device.sealedAlready).not.toHaveBeenCalled();
    });

    it("while held, seals only into a conversation sealed already, asking once", async () => {
        configureSealedChat("viewer-1", { held: true });
        expect(await sealsSendsIn("sealed")).toBe(true);
        expect(await sealsSendsIn("plain")).toBe(false);
        expect(await sealsSendsIn("sealed")).toBe(true);
        expect(device.sealedAlready).toHaveBeenCalledTimes(2);
    });

    it("keeps the held state for a caller that does not name it", async () => {
        configureSealedChat("viewer-1", { held: true });
        configureSealedChat("viewer-1");
        expect(await sealsSendsIn("plain")).toBe(false);
    });

    it("throws rather than answering plain when it cannot tell", async () => {
        configureSealedChat("viewer-1", { held: true });
        device.sealedAlready.mockRejectedValueOnce(new Error("offline"));
        await expect(sealsSendsIn("sealed")).rejects.toThrow("offline");
        expect(await sealsSendsIn("sealed")).toBe(true);
    });
});
