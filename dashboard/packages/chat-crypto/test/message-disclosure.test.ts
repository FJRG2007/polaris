/**
 * A reader's disclosure of one sealed message (docs/chat-e2ee-mls.md, "Sealed
 * reports"): it opens exactly that message at that revision, nothing moved to
 * another binding, no other message of the same epoch and nothing tampered.
 */

import { describe, expect, it } from "vitest";
import * as content from "../src/message-content";

const HK = new Uint8Array(32).map((_, index) => index);
const BINDING = { conversationId: "0190a5b2-0000-7000-8000-000000000001", epoch: 7n, messageId: "0190a5b2-0000-7000-8000-0000000000aa", senderLeaf: 3 };
const text = new TextEncoder();

describe("message disclosure", () => {
    it("opens the message it was taken for", async () => {
        const sealed = await content.sealMessage(HK, BINDING, text.encode("reported words"));
        const disclosure = await content.messageDisclosure(HK, BINDING);
        expect(disclosure).toHaveLength(content.DISCLOSURE_BYTES);
        expect(new TextDecoder().decode(await content.openDisclosed(disclosure, BINDING, sealed))).toBe("reported words");
    });

    it("opens no other message, revision or binding", async () => {
        const disclosure = await content.messageDisclosure(HK, BINDING);
        const other = { ...BINDING, messageId: "0190a5b2-0000-7000-8000-0000000000bb" };
        const otherSealed = await content.sealMessage(HK, other, text.encode("not reported"));
        await expect(content.openDisclosed(disclosure, other, otherSealed)).rejects.toBeInstanceOf(content.MessageOpenError);
        const edited = { ...BINDING, revision: 1 };
        const editedSealed = await content.sealMessage(HK, edited, text.encode("the edit"));
        await expect(content.openDisclosed(disclosure, edited, editedSealed)).rejects.toBeInstanceOf(content.MessageOpenError);
        const sealed = await content.sealMessage(HK, BINDING, text.encode("bound"));
        for (const moved of [{ ...BINDING, senderLeaf: 4 }, { ...BINDING, epoch: 8n }, { ...BINDING, conversationId: "x" }])
            await expect(content.openDisclosed(disclosure, moved, sealed)).rejects.toBeInstanceOf(content.MessageOpenError);
    });

    it("refuses a flipped byte in the ciphertext or the disclosure, and a wrong size", async () => {
        const sealed = await content.sealMessage(HK, BINDING, text.encode("tamper me"));
        const disclosure = await content.messageDisclosure(HK, BINDING);
        for (let index = 0; index < sealed.length; index++) {
            const bad = sealed.slice();
            bad[index] ^= 0x01;
            await expect(content.openDisclosed(disclosure, BINDING, bad)).rejects.toBeInstanceOf(content.MessageOpenError);
        }
        for (let index = 0; index < disclosure.length; index++) {
            const bad = disclosure.slice();
            bad[index] ^= 0x01;
            await expect(content.openDisclosed(bad, BINDING, sealed)).rejects.toBeInstanceOf(content.MessageOpenError);
        }
        await expect(content.openDisclosed(disclosure.subarray(1), BINDING, sealed)).rejects.toBeInstanceOf(content.MessageOpenError);
    });

    it("is not the history key", async () => {
        const disclosure = await content.messageDisclosure(HK, BINDING);
        expect(Buffer.from(disclosure.subarray(0, 32)).equals(Buffer.from(HK))).toBe(false);
    });
});
