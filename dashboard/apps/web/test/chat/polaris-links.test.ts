/**
 * A link to this Polaris, pasted into a conversation.
 *
 * It used to be treated as any other website: Polaris fetched its own page and
 * drew a card describing itself back to somebody already inside it. What it is
 * now is the thing it points at - a conversation as a name in the sentence, a
 * voice room as a card with a way in, a message as the message.
 *
 * The part worth asserting is the addressing, because it is where this silently
 * goes wrong. A message address is a conversation address with the message on
 * the end, so a pattern order that put the conversation first would turn every
 * link to a message into a link to the room it is in - which reads almost right
 * and is not.
 */

import { describe, expect, it } from "vitest";
import { chipLabel } from "@/components/rich-text/chip";
import { extractReferences } from "@/components/rich-text/markdown";
import { referenceFromUrl, referenceHref, referenceSigil } from "@/components/rich-text/references";

const HERE = "https://polaris.example";
const CHANNEL = "0193aaaa-1111-4222-8333-444444444444";
const MESSAGE = "0193bbbb-5555-4666-8777-888888888888";

describe("reading the address", () => {
    it("reads a conversation", () => {
        expect(referenceFromUrl(`/chat/c/${CHANNEL}`, null)).toEqual({
            kind: "channel",
            id: CHANNEL
        });
    });

    it("reads a message as the message, not as the room it is in", () => {
        expect(referenceFromUrl(`/chat/c/${CHANNEL}/${MESSAGE}`, null)).toEqual({
            kind: "message",
            id: MESSAGE
        });
    });

    it("reads a full address on this deployment", () => {
        expect(referenceFromUrl(`${HERE}/chat/c/${CHANNEL}`, HERE)).toEqual({
            kind: "channel",
            id: CHANNEL
        });
    });

    it("leaves somebody else's site alone", () => {
        expect(referenceFromUrl(`https://elsewhere.example/chat/c/${CHANNEL}`, HERE)).toBeNull();
    });

    it("leaves a full address alone when there is no deployment to compare against", () => {
        expect(referenceFromUrl(`${HERE}/chat/c/${CHANNEL}`, null)).toBeNull();
    });

    it("refuses something shaped like an address but carrying no id", () => {
        expect(referenceFromUrl("/chat/c/not-an-id", null)).toBeNull();
    });
});

describe("where a chip goes", () => {
    it("opens the conversation", () => {
        expect(referenceHref("channel", CHANNEL)).toBe(`/chat/c/${CHANNEL}`);
    });

    it("gives a message nowhere to go on its own", () => {
        // Its address needs the conversation it lives in, which the link does
        // not carry and which is not the link's to assert: whoever resolves it
        // for a reader says where it is, and only if they may go there.
        expect(referenceHref("message", MESSAGE)).toBeNull();
    });

    it("writes a conversation the way every client writes one", () => {
        expect(referenceSigil("channel")).toBe("#");
    });
});

describe("what a pasted address is called before anybody resolves it", () => {
    it("is not the address", () => {
        expect(chipLabel("channel", `${HERE}/chat/c/${CHANNEL}`)).toBe("#Conversation");
        expect(chipLabel("message", `${HERE}/chat/c/${CHANNEL}/${MESSAGE}`)).toBe("Message");
    });

    it("keeps a real name when there is one", () => {
        expect(chipLabel("channel", "general")).toBe("#general");
    });
});

describe("finding them in what somebody wrote", () => {
    it("finds a bare address somebody pasted", () => {
        expect(extractReferences(`look at ${HERE}/chat/c/${CHANNEL}`, HERE)).toEqual([
            { kind: "channel", id: CHANNEL }
        ]);
    });

    it("finds the stored form the composer writes", () => {
        expect(extractReferences(`see [#general](polaris:channel/${CHANNEL})`)).toEqual([
            { kind: "channel", id: CHANNEL }
        ]);
    });

    it("does not find one inside a code fence", () => {
        // Which is exactly where somebody would put an address to talk about it
        // rather than to point at it.
        const body = ["```", `${HERE}/chat/c/${CHANNEL}`, "```"].join("\n");
        expect(extractReferences(body, HERE)).toEqual([]);
    });

    it("finds each address once, however many times it is written", () => {
        const body = `${HERE}/chat/c/${CHANNEL} and again ${HERE}/chat/c/${CHANNEL}`;
        expect(extractReferences(body, HERE)).toHaveLength(1);
    });
});
