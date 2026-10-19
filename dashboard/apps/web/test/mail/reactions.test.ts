/**
 * Emoji reactions, in the format Gmail reads and writes.
 *
 * A reaction is a reply with one extra body part, and both directions have to
 * hold for it to be worth anything: what Polaris sends must be a reaction in
 * Gmail (the part, its JSON, In-Reply-To naming the message), and what Gmail
 * sends must be recognised here so it is drawn under its message instead of as
 * a one-character reply. The part order is Google's: the reaction between the
 * plain text and the HTML, so a client that shows only the first or only the
 * last part of an alternative still lands on the emoji.
 */

import * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { composeMime } from "@/lib/mailbox/send";
import { readShape } from "@/lib/mailbox/structure";
import type { MessageStructureObject } from "imapflow";

function node(over: Partial<MessageStructureObject>): MessageStructureObject {
    return { type: "text/plain", ...over } as MessageStructureObject;
}

describe("what a reaction may carry", () => {
    it("is exactly one emoji, however many code points draw it", () => {
        expect(core.isMailReaction("👍")).toBe(true);
        expect(core.isMailReaction("👍🏽")).toBe(true);
        expect(core.isMailReaction("👨‍👩‍👧")).toBe(true);
        expect(core.isMailReaction("🇪🇸")).toBe(true);
        expect(core.isMailReaction(" 🎉 ")).toBe(true);
    });

    it("is never text, two emoji, or a space's own emoji", () => {
        expect(core.isMailReaction("")).toBe(false);
        expect(core.isMailReaction("ok")).toBe(false);
        expect(core.isMailReaction("👍👍")).toBe(false);
        expect(core.isMailReaction("👍 thanks")).toBe(false);
        expect(core.isMailReaction(":party:")).toBe(false);
    });

    it("reads the emoji back out of a reaction's text", () => {
        expect(core.mailReactionFrom("❤️\n")).toBe("❤️");
        expect(core.mailReactionFrom("Sent from my phone")).toBe("");
    });

    it("writes the JSON Google defines", () => {
        expect(JSON.parse(core.mailReactionJson("😂"))).toEqual({ version: 1, emoji: "😂" });
    });
});

describe("a reaction arriving", () => {
    it("is recognised by its part, and the part is never offered as a file", () => {
        const shape = readShape(
            node({
                type: "multipart/alternative",
                childNodes: [
                    node({ part: "1", type: "text/plain" }),
                    node({ part: "2", type: core.MAIL_REACTION_TYPE }),
                    node({ part: "3", type: "text/html" })
                ]
            })
        );
        expect(shape.reaction).toBe(true);
        expect(shape.textPart).toBe("1");
        expect(shape.htmlPart).toBe("3");
        expect(shape.attachments).toHaveLength(0);
    });

    it("is not claimed for an ordinary message", () => {
        const shape = readShape(
            node({
                type: "multipart/alternative",
                childNodes: [
                    node({ part: "1", type: "text/plain" }),
                    node({ part: "2", type: "text/html" })
                ]
            })
        );
        expect(shape.reaction).toBe(false);
    });
});

describe("a reaction going out", () => {
    const base = {
        from: { name: "Ana", address: "ana@example.test" },
        to: [{ name: "Ben", address: "ben@example.test" }],
        cc: [],
        bcc: [],
        replyTo: "",
        subject: "Re: The quarter",
        attachments: [],
        inReplyTo: "<original@example.test>",
        references: ["<original@example.test>"],
        requestReceipt: false
    };

    it("carries the reaction part between the text and the HTML, answering the message", async () => {
        const { mime } = await composeMime({ ...base, body: "👍", reaction: "👍" });
        const text = mime.toString("utf8");
        expect(text).toMatch(/^In-Reply-To: <original@example\.test>/m);
        const plain = text.indexOf("Content-Type: text/plain");
        const reaction = text.indexOf(`Content-Type: ${core.MAIL_REACTION_TYPE}`);
        const html = text.indexOf("Content-Type: text/html");
        expect(plain).toBeGreaterThan(-1);
        expect(reaction).toBeGreaterThan(plain);
        expect(html).toBeGreaterThan(reaction);
        expect(text).toMatch(/multipart\/alternative/);
    });

    it("leaves an ordinary message as it was", async () => {
        const { mime } = await composeMime({ ...base, body: "Thanks, sounds good." });
        expect(mime.toString("utf8")).not.toContain(core.MAIL_REACTION_TYPE);
    });
});

describe("the queue refusing what is not a reaction", () => {
    const valid = {
        accountId: "0190c1d2-0000-7000-8000-000000000001",
        to: [{ address: "ben@example.test" }],
        body: "👍",
        inReplyToId: "0190c1d2-0000-7000-8000-0000000000e1"
    };

    it("takes one emoji answering a message", () => {
        expect(core.mailComposeSchema.safeParse({ ...valid, reaction: "👍" }).success).toBe(true);
    });

    it("refuses words, a reaction to nothing, and a crowd past Gmail's limit", () => {
        expect(core.mailComposeSchema.safeParse({ ...valid, reaction: "yes" }).success).toBe(false);
        expect(
            core.mailComposeSchema.safeParse({ ...valid, inReplyToId: null, reaction: "👍" })
                .success
        ).toBe(false);
        const crowd = Array.from(
            { length: core.MAIL_REACTION_MOST_RECIPIENTS + 1 },
            (_, index) => ({
                address: `person${index}@example.test`
            })
        );
        expect(
            core.mailComposeSchema.safeParse({ ...valid, to: crowd, reaction: "👍" }).success
        ).toBe(false);
    });

    it("still sends an ordinary message with no reaction", () => {
        const parsed = core.mailComposeSchema.safeParse({ ...valid, body: "Hello" });
        expect(parsed.success && parsed.data.reaction).toBe("");
    });
});
