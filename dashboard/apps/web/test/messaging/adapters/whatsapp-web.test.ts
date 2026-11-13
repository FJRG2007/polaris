import { describe, expect, it, vi } from "vitest";

// The adapter's socket is never opened here: only its pure helpers and the
// refusal to send before a link are exercised, so Baileys is stubbed out.
vi.mock("@whiskeysockets/baileys", () => ({
    DisconnectReason: { loggedOut: 401, restartRequired: 515 },
    makeWASocket: vi.fn(),
    useMultiFileAuthState: vi.fn()
}));

import { recipientOf, textOf, WhatsAppWebAdapter } from "@/lib/messaging/adapters/whatsapp-web";

describe("textOf", () => {
    it("reads a plain conversation text", () => {
        expect(textOf({ conversation: "hello" })).toBe("hello");
    });

    it("reads an extended text", () => {
        expect(textOf({ extendedTextMessage: { text: "quoted reply" } })).toBe("quoted reply");
    });

    it("is empty for anything without text", () => {
        expect(textOf(undefined)).toBe("");
        expect(textOf(null)).toBe("");
        expect(textOf({ conversation: null, extendedTextMessage: null })).toBe("");
    });
});

describe("recipientOf", () => {
    it("keeps a user or group id as given", () => {
        expect(recipientOf("34600111222@s.whatsapp.net")).toEqual({ jid: "34600111222@s.whatsapp.net" });
        expect(recipientOf("1203630@g.us")).toEqual({ jid: "1203630@g.us" });
    });

    it("reduces a typed phone number to its digits", () => {
        expect(recipientOf("+34 600 11 12 22")).toEqual({ digits: "34600111222" });
    });

    it("refuses something with no digits", () => {
        expect(recipientOf("")).toBeNull();
        expect(recipientOf("not a number")).toBeNull();
    });
});

describe("WhatsAppWebAdapter.send", () => {
    it("refuses to send before the number is linked", async () => {
        const adapter = new WhatsAppWebAdapter("chan-1", { channelId: "chan-1", onInbound: vi.fn(), log: vi.fn() });
        await expect(adapter.send({ peerId: "34600111222", text: "hi" })).rejects.toThrow(/not linked/);
    });
});
