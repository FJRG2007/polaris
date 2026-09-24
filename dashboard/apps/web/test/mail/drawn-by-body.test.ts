/**
 * Which pictures a message draws, decided from its body once the body is here.
 *
 * A newsletter's icons and an iPhone's attached photo can have the same shape:
 * an image with a Content-Id beside the HTML. Only the HTML says which one it
 * draws, and a paperclip on every newsletter is the cost of not asking it.
 */

import { describe, expect, it } from "vitest";
import { drawnByBody } from "@/lib/mailbox/attachment-rows";

const part = (over: Record<string, unknown>) => ({
    part: "2",
    name: "icon.gif",
    contentType: "image/gif",
    size: 100,
    contentId: "apple_youtube",
    inline: false,
    ...over
});

describe("pictures the body draws", () => {
    it("takes an image the HTML asks for by cid as part of the message", () => {
        const [one] = drawnByBody([part({})], '<img src="CID:apple_youtube">');
        expect(one?.inline).toBe(true);
    });

    it("leaves a photo the HTML never mentions as a file", () => {
        const [one] = drawnByBody([part({ name: "IMG_0001.jpeg" })], "<p>Here it is</p>");
        expect(one?.inline).toBe(false);
    });

    it("never turns a document into part of the body", () => {
        const [one] = drawnByBody(
            [part({ contentType: "application/pdf", contentId: "doc" })],
            '<a href="cid:doc">'
        );
        expect(one?.inline).toBe(false);
    });

    it("changes nothing without a body to read", () => {
        const [one] = drawnByBody([part({})], "");
        expect(one?.inline).toBe(false);
    });
});
