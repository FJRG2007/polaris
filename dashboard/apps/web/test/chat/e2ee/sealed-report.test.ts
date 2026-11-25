/**
 * A report of a sealed message (docs/chat-e2ee-mls.md, "Sealed reports"): the
 * reader's disclosure opens that one message for the moderators, and only when
 * the stored row is what its sender signed. A disclosure for another message or
 * revision, a tampered row or a forged signature opens nothing.
 */

import { describe, expect, it } from "vitest";
import { sealedRow } from "./support/sealed-row";
import * as content from "@polaris/chat-crypto/message-content";
import { DISCLOSURE_PATTERN, isSealedRow, openReported, reportedText } from "@/lib/chat/e2ee/sealed-report";

const CHANNEL = "018f2b7a-0000-7000-8000-0000000000c1";

describe("sealed reports", () => {
    it("opens the reported message with its disclosure", async () => {
        const { row, disclosure } = await sealedRow(CHANNEL, { body: "the abuse" });
        expect(isSealedRow(row)).toBe(true);
        expect(DISCLOSURE_PATTERN.test(disclosure)).toBe(true);
        const opened = await openReported(row, disclosure);
        expect(opened?.body).toBe("the abuse");
        expect(reportedText(opened!)).toBe("the abuse");
    });

    it("reads a forum post's title before its text", async () => {
        const { row, disclosure } = await sealedRow(CHANNEL, { body: "first post", title: "A title" });
        expect(reportedText((await openReported(row, disclosure))!)).toBe("A title\nfirst post");
    });

    it("opens an edited version only with that version's disclosure", async () => {
        const { row, binding, disclose } = await sealedRow(CHANNEL, { body: "edited" }, { revision: 2 });
        expect((await openReported(row, await disclose()))?.body).toBe("edited");
        expect(await openReported(row, await disclose({ ...binding, revision: 1 }))).toBeNull();
    });

    it("opens nothing with another message's disclosure", async () => {
        const { row, binding, disclose } = await sealedRow(CHANNEL, { body: "kept" });
        expect(await openReported(row, await disclose({ ...binding, messageId: crypto.randomUUID() }))).toBeNull();
    });

    it("opens nothing that its sender did not sign", async () => {
        const { row, disclosure } = await sealedRow(CHANNEL, { body: "signed" });
        const forged = new Uint8Array(row.e2eeSignature);
        forged[0] ^= 1;
        expect(await openReported({ ...row, e2eeSignature: forged }, disclosure)).toBeNull();
        const other = await sealedRow(CHANNEL, { body: "someone else" });
        expect(await openReported({ ...row, e2eeSignatureKey: other.row.e2eeSignatureKey }, disclosure)).toBeNull();
        // Other words in the row, unsigned by the sender, are not the sender's message.
        const binding = { conversationId: CHANNEL, epoch: 4n, messageId: row.clientKey, senderLeaf: 2 };
        const swapped = await content.sealMessage(new Uint8Array(32), binding, new TextEncoder().encode("{}"));
        expect(await openReported({ ...row, e2eeCiphertext: swapped }, disclosure)).toBeNull();
    });

    it("opens nothing moved to another conversation, and takes no malformed disclosure", async () => {
        const { row, disclosure } = await sealedRow(CHANNEL, { body: "here" });
        expect(await openReported({ ...row, channelId: "018f2b7a-0000-7000-8000-0000000000c2" }, disclosure)).toBeNull();
        expect(await openReported(row, disclosure.slice(1))).toBeNull();
        expect(await openReported(row, `${disclosure.slice(0, -1)}!`)).toBeNull();
        expect(await openReported({ ...row, clientKey: null }, disclosure)).toBeNull();
    });

    it("tells a plain row from a sealed one", () => {
        expect(isSealedRow({ e2eeCiphertext: null })).toBe(false);
        expect(isSealedRow({})).toBe(false);
    });
});
