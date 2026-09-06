/**
 * Reading a message's shape from the description IMAP gives before it sends one.
 *
 * Every decision the app makes about a message before somebody opens it comes
 * out of here: which part to read for the snippet, what to offer as a download,
 * and whether the list draws a paperclip. The last one is the one people notice
 * being wrong - a signature logo counted as an attachment puts a paperclip on
 * every message from one colleague.
 */

import { describe, expect, it } from "vitest";
import type { MessageStructureObject } from "imapflow";
import { readShape, WHOLE_BODY } from "@/lib/mailbox/structure";

function node(over: Partial<MessageStructureObject>): MessageStructureObject {
    return { type: "text/plain", ...over } as MessageStructureObject;
}

describe("finding the text", () => {
    it("prefers the plain half of a message sent both ways", () => {
        const shape = readShape(
            node({
                type: "multipart/alternative",
                childNodes: [
                    node({ part: "1", type: "text/plain" }),
                    node({ part: "2", type: "text/html" })
                ]
            })
        );
        expect(shape.textPart).toBe("1");
        expect(shape.htmlPart).toBe("2");
    });

    it("addresses a message with no parts as the whole body", () => {
        expect(readShape(node({ type: "text/plain" })).textPart).toBe(WHOLE_BODY);
        expect(readShape(node({ type: "text/html" })).htmlPart).toBe(WHOLE_BODY);
    });

    it("answers nothing at all for a message that was never described", () => {
        const shape = readShape(undefined);
        expect(shape.textPart).toBe("");
        expect(shape.attachments).toHaveLength(0);
        expect(shape.hasAttachments).toBe(false);
    });
});

describe("finding the files", () => {
    it("lists what somebody attached and draws the paperclip for it", () => {
        const shape = readShape(
            node({
                type: "multipart/mixed",
                childNodes: [
                    node({ part: "1", type: "text/plain" }),
                    node({
                        part: "2",
                        type: "application/pdf",
                        size: 4096,
                        disposition: "attachment",
                        dispositionParameters: { filename: "invoice.pdf" }
                    })
                ]
            })
        );
        expect(shape.attachments).toHaveLength(1);
        expect(shape.attachments[0]).toMatchObject({
            part: "2",
            name: "invoice.pdf",
            contentType: "application/pdf",
            size: 4096,
            inline: false
        });
        expect(shape.hasAttachments).toBe(true);
    });

    it("does not put a paperclip on a message whose only picture is its own signature", () => {
        const shape = readShape(
            node({
                type: "multipart/related",
                childNodes: [
                    node({ part: "1", type: "text/html" }),
                    node({
                        part: "2",
                        type: "image/png",
                        id: "<logo@corp>",
                        disposition: "inline",
                        dispositionParameters: { filename: "logo.png" }
                    })
                ]
            })
        );
        expect(shape.attachments).toHaveLength(1);
        expect(shape.attachments[0]?.inline).toBe(true);
        expect(shape.attachments[0]?.contentId).toBe("logo@corp");
        expect(shape.hasAttachments).toBe(false);
    });

    it("gives a part with no filename something to be downloaded as", () => {
        const shape = readShape(
            node({
                type: "multipart/mixed",
                childNodes: [
                    node({ part: "1", type: "text/plain" }),
                    node({ part: "2", type: "application/zip", disposition: "attachment" })
                ]
            })
        );
        expect(shape.attachments[0]?.name).toBe("part-2.zip");
    });

    it("does not take a forwarded message's own text as this message's text", () => {
        const shape = readShape(
            node({
                type: "multipart/mixed",
                childNodes: [
                    node({ part: "1", type: "text/plain" }),
                    node({
                        part: "2",
                        type: "message/rfc822",
                        disposition: "attachment",
                        dispositionParameters: { filename: "forwarded.eml" }
                    })
                ]
            })
        );
        expect(shape.textPart).toBe("1");
        expect(shape.attachments.map((one) => one.part)).toEqual(["2"]);
    });
});
