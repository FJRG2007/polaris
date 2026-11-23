/**
 * The chat screens' side of sealed messages: the content inside the seal is a
 * versioned document parsed like a plain send (anything else opens to
 * nothing), a sealed row is drawn with what it opened to and an unsealed list
 * comes back untouched, and nothing loads the MLS device while sealed chat is
 * off.
 */

import { describe, expect, it } from "vitest";
import * as sealedChat from "@/lib/chat/e2ee/sealed-chat";
import { withOpened } from "@/app/(app)/chat/opened-sealed";
import type { ChatMessageView } from "@/lib/chat/messages";

const encoder = new TextEncoder();
const row = (id: string, sealed: boolean) => ({ id, channelId: "c", body: "", ...(sealed ? { sealed: true } : {}) }) as unknown as ChatMessageView;

describe("sealed chat content", () => {
    it("round-trips the text and a live translation's original", () => {
        const content: sealedChat.SealedContent = { body: "hola", translation: { from: "en", to: "es", original: "hello" } };
        const opened = sealedChat.decodeSealedContent(sealedChat.encodeSealedContent(content));
        expect(opened).toEqual(content);
        expect(sealedChat.decodeSealedContent(sealedChat.encodeSealedContent({ body: "plain" }))).toEqual({ body: "plain" });
    });

    it("opens anything that is not this version's document to nothing", () => {
        for (const bytes of [encoder.encode("not json"), encoder.encode('{"v":2,"body":"x"}'), encoder.encode('{"v":1}'), new Uint8Array([0xff, 0xfe])])
            expect(sealedChat.decodeSealedContent(bytes)).toBeNull();
    });

    it("draws sealed rows with what they opened to and leaves the rest", () => {
        const list = [row("a", true), row("b", false), row("c", true)];
        const drawn = withOpened(list, (id) => (id === "a" ? { body: "opened" } : id === "c" ? null : undefined));
        expect(drawn.map((m) => m.body)).toEqual(["opened", "", ""]);
        expect(drawn[1]).toBe(list[1]);
        const plain = [row("x", false)];
        expect(withOpened(plain, () => ({ body: "never" }))).toBe(plain);
    });

    it("stays off until configured, and refuses to send while off", async () => {
        sealedChat.configureSealedChat(null);
        expect(sealedChat.sealedChatActive()).toBe(false);
        await expect(sealedChat.sendSealedMessage({ channelId: "c", body: "x", clientKey: crypto.randomUUID() })).rejects.toThrow("sealed chat is off");
    });

    it("tells a refusal from a server it could not reach", () => {
        const failure = (status: number) => Object.assign(new Error("x"), { name: "MlsRequestError", status });
        expect(sealedChat.sealedSendFailure(failure(409))).toBe("refused");
        expect(sealedChat.sealedSendFailure(failure(429))).toBe("unreachable");
        expect(sealedChat.sealedSendFailure(failure(503))).toBe("unreachable");
        expect(sealedChat.sealedSendFailure(new TypeError("fetch failed"))).toBe("unreachable");
    });
});
