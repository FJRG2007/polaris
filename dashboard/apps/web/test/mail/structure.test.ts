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

    it("lists an attached message once, as imapflow really describes it", () => {
        // imapflow gives a message/rfc822 part the forwarded message's own tree as
        // children, at the same part number. Walking into it listed its pieces
        // and read its text as this message's body.
        const shape = readShape(
            node({
                type: "multipart/mixed",
                childNodes: [
                    node({ part: "1", type: "text/html" }),
                    node({
                        part: "2",
                        type: "message/rfc822",
                        size: 9000,
                        envelope: { subject: "Quarterly numbers" } as never,
                        childNodes: [
                            node({
                                part: "2",
                                type: "multipart/mixed",
                                childNodes: [
                                    node({ part: "2.1", type: "text/plain" }),
                                    node({
                                        part: "2.2",
                                        type: "application/pdf",
                                        disposition: "attachment",
                                        dispositionParameters: { filename: "q3.pdf" }
                                    })
                                ]
                            })
                        ]
                    })
                ]
            })
        );
        expect(shape.htmlPart).toBe("1");
        expect(shape.textPart).toBe("");
        expect(shape.attachments).toEqual([
            expect.objectContaining({ part: "2", name: "Quarterly numbers.eml", inline: false })
        ]);
        expect(shape.hasAttachments).toBe(true);
    });

    it("lists what an iPhone attached, Content-Id and all", () => {
        // Apple Mail marks every attachment inline with a Content-Id, beside the
        // text in a multipart/mixed. Filed as part of the body, they were shown
        // nowhere at all.
        const shape = readShape(
            node({
                type: "multipart/mixed",
                childNodes: [
                    node({ part: "1", type: "text/plain" }),
                    node({
                        part: "2",
                        type: "application/pdf",
                        id: "<A1B2@apple>",
                        disposition: "inline",
                        dispositionParameters: { filename: "contract.pdf" }
                    }),
                    node({
                        part: "3",
                        type: "image/jpeg",
                        id: "<C3D4@apple>",
                        disposition: "inline",
                        dispositionParameters: { filename: "IMG_0001.jpeg" }
                    })
                ]
            })
        );
        expect(shape.attachments.map((one) => [one.name, one.inline])).toEqual([
            ["contract.pdf", false],
            ["IMG_0001.jpeg", false]
        ]);
        expect(shape.hasAttachments).toBe(true);
    });

    it("keeps a picture the HTML draws out of the files, even without a filename", () => {
        const shape = readShape(
            node({
                type: "multipart/related",
                childNodes: [
                    node({ part: "1", type: "text/html" }),
                    node({ part: "2", type: "image/gif", id: "<spacer>" })
                ]
            })
        );
        expect(shape.attachments[0]?.inline).toBe(true);
        expect(shape.hasAttachments).toBe(false);
    });

    it("takes a message that is only a file as that file, not as text", () => {
        // A scanner's "send by mail": the whole message is the PDF.
        const shape = readShape(
            node({
                type: "application/pdf",
                size: 120_000,
                parameters: { name: "scan.pdf" }
            })
        );
        expect(shape.textPart).toBe("");
        expect(shape.htmlPart).toBe("");
        expect(shape.attachments).toEqual([
            expect.objectContaining({ part: "1", name: "scan.pdf", inline: false })
        ]);
        expect(shape.hasAttachments).toBe(true);
    });

    it("lists a named text file that comes after the body", () => {
        const shape = readShape(
            node({
                type: "multipart/mixed",
                childNodes: [
                    node({ part: "1", type: "text/plain" }),
                    node({ part: "2", type: "text/plain", parameters: { name: "notes.txt" } })
                ]
            })
        );
        expect(shape.textPart).toBe("1");
        expect(shape.attachments.map((one) => one.name)).toEqual(["notes.txt"]);
    });
});
