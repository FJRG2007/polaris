/**
 * The content layer over MLS: a message opens only with its own history key
 * and its own binding (conversation, epoch, message id, sender leaf); every
 * flipped byte, swapped field or wrong key fails with the one coarse error;
 * the derivation is pinned by a known-answer vector so a refactor cannot
 * silently change what stored ciphertexts need to open; and a history-key
 * envelope opens only for the account, conversation and epoch it was sealed to.
 */

import { describe, expect, it } from "vitest";
import * as account from "../src/account-key";
import * as content from "../src/message-content";

const HK = new Uint8Array(32).map((_, index) => index);
const BINDING = { conversationId: "0190a5b2-0000-7000-8000-000000000001", epoch: 7n, messageId: "0190a5b2-0000-7000-8000-0000000000aa", senderLeaf: 3 };
const text = new TextEncoder();
const hex = (value: Uint8Array) => Buffer.from(value).toString("hex");

describe("message content", () => {
    it("round-trips and is deterministic for one binding (known-answer vector)", async () => {
        const sealed = await content.sealMessage(HK, BINDING, text.encode("hello"));
        expect(sealed[0]).toBe(content.MESSAGE_CONTENT_VERSION);
        expect(sealed).toHaveLength(1 + 5 + 16);
        expect(hex(sealed)).toBe(hex(await content.sealMessage(HK, BINDING, text.encode("hello"))));
        expect(hex(sealed)).toMatchInlineSnapshot(`"01dea1843a3e42febe124ca989d3aabb8bd2a6fb3c7e"`);
        expect(new TextDecoder().decode(await content.openMessage(HK, BINDING, sealed))).toBe("hello");
    });

    it("refuses every flipped byte", async () => {
        const sealed = await content.sealMessage(HK, BINDING, text.encode("tamper me"));
        for (let index = 0; index < sealed.length; index++) {
            const bad = sealed.slice();
            bad[index] ^= 0x01;
            await expect(content.openMessage(HK, BINDING, bad)).rejects.toBeInstanceOf(content.MessageOpenError);
        }
        await expect(content.openMessage(HK, BINDING, sealed.subarray(0, 10))).rejects.toBeInstanceOf(content.MessageOpenError);
    });

    it("refuses a ciphertext moved to another conversation, epoch, message, sender or key", async () => {
        const sealed = await content.sealMessage(HK, BINDING, text.encode("bound"));
        const moved = [
            { ...BINDING, conversationId: "0190a5b2-0000-7000-8000-000000000002" },
            { ...BINDING, epoch: 8n },
            { ...BINDING, messageId: "0190a5b2-0000-7000-8000-0000000000ab" },
            { ...BINDING, senderLeaf: 4 },
            // A boundary shift between two fields must not read as the same binding.
            { ...BINDING, conversationId: `${BINDING.conversationId}0`, messageId: BINDING.messageId.slice(1) }
        ];
        for (const binding of moved) await expect(content.openMessage(HK, binding, sealed)).rejects.toBeInstanceOf(content.MessageOpenError);
        const other = HK.slice();
        other[0] ^= 1;
        await expect(content.openMessage(other, BINDING, sealed)).rejects.toBeInstanceOf(content.MessageOpenError);
    });

    it("refuses malformed inputs before deriving anything", async () => {
        await expect(content.sealMessage(new Uint8Array(31), BINDING, text.encode("x"))).rejects.toThrow(RangeError);
        await expect(content.sealMessage(HK, { ...BINDING, senderLeaf: -1 }, text.encode("x"))).rejects.toThrow(RangeError);
        await expect(content.sealMessage(HK, { ...BINDING, messageId: "" }, text.encode("x"))).rejects.toThrow(RangeError);
        expect(content.newHistoryKey()).toHaveLength(content.HISTORY_KEY_BYTES);
        expect(hex(content.newHistoryKey())).not.toBe(hex(content.newHistoryKey()));
    });
});

describe("history-key envelopes", () => {
    it("open only for the account, conversation and epoch they were sealed to", async () => {
        const ak = account.generateAccountKey();
        const { hpkePublicKey } = await account.accountPublicKeys(ak);
        const { privateKey } = await account.accountHpkeKeyPair(ak);
        const binding = { recipient: "user-1", conversationId: BINDING.conversationId, epoch: 7n };
        const envelope = await content.sealHistoryKey(hpkePublicKey, HK, binding);
        expect(hex(await content.openHistoryKey(privateKey, envelope, binding))).toBe(hex(HK));
        for (const wrong of [{ ...binding, recipient: "user-2" }, { ...binding, conversationId: "other" }, { ...binding, epoch: 6n }])
            await expect(content.openHistoryKey(privateKey, envelope, wrong)).rejects.toThrow();
        const otherAk = await account.accountHpkeKeyPair(account.generateAccountKey());
        await expect(content.openHistoryKey(otherAk.privateKey, envelope, binding)).rejects.toThrow();
    });
});
