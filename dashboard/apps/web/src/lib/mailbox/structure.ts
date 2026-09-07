/**
 * Reading a message's shape without downloading it.
 *
 * IMAP will describe a message before it sends one: which parts it has, what
 * each is, how big, and whether a part is a file somebody attached or a picture
 * the HTML refers to. That description is a few hundred bytes and the message
 * can be forty megabytes, so every decision this app makes about a message
 * before somebody opens it is made from here.
 *
 * Three things are wanted out of it and each has an edge that has bitten every
 * mail client ever written:
 *
 * - **Which part is the text.** A `multipart/alternative` carries the same
 *   message twice and the plain half is the one worth reading for a snippet.
 *   A message with no multipart at all has no part number: the whole body is
 *   the text, and IMAP addresses it as `TEXT`, which is not a number.
 * - **Which parts are attachments.** Not "everything that is not text": a
 *   picture referred to by the HTML has a Content-Id and is part of the message
 *   rather than a file, and showing it as a paperclip is how a signature logo
 *   ends up looking like an attachment on every message from one colleague.
 * - **Whether there are any.** The paperclip in the list, decided from the same
 *   walk so it can never disagree with what the message then shows.
 */

import type { MessageStructureObject } from "imapflow";

/** One part of a message that is a file. */
export interface MessagePart {
    /** How IMAP addresses it. */
    readonly part: string;
    readonly name: string;
    readonly contentType: string;
    readonly size: number;
    /** The Content-Id, bare, for a part the HTML refers to. */
    readonly contentId: string;
    /** True when it is part of the message rather than attached to it. */
    readonly inline: boolean;
}

/** How a part was wrapped for the journey, and what its bytes mean. Carried
 *  because a part read without them is the mojibake that made a Spanish thread
 *  read as `Mar=C3=ADa` in every preview line. */
export interface PartCoding {
    readonly encoding: string;
    readonly charset: string;
    /** Whether a plain-text part is soft-wrapped, so the paragraphs can be put
     *  back together instead of arriving in 72-character pieces. */
    readonly flowed: boolean;
}

/** What one message is made of. */
export interface MessageShape {
    /** The part holding the plain text, or "" when there is none. */
    readonly textPart: string;
    /** The part holding the HTML, or "" when there is none. */
    readonly htmlPart: string;
    readonly textCoding: PartCoding;
    readonly htmlCoding: PartCoding;
    readonly attachments: readonly MessagePart[];
    /** Whether the paperclip is drawn: a file somebody attached, not a picture
     *  the message draws itself with. */
    readonly hasAttachments: boolean;
}

/** IMAP's name for the body of a message that has no parts. */
export const WHOLE_BODY = "TEXT";

const NO_CODING: PartCoding = { encoding: "", charset: "", flowed: false };

const EMPTY: MessageShape = {
    textPart: "",
    htmlPart: "",
    textCoding: NO_CODING,
    htmlCoding: NO_CODING,
    attachments: [],
    hasAttachments: false
};

function codingOf(node: MessageStructureObject): PartCoding {
    return {
        encoding: node.encoding ?? "",
        charset: node.parameters?.charset ?? "",
        flowed: (node.parameters?.format ?? "").toLowerCase() === "flowed"
    };
}

export function readShape(structure: MessageStructureObject | undefined): MessageShape {
    if (!structure) return EMPTY;
    const attachments: MessagePart[] = [];
    let textPart = "";
    let htmlPart = "";
    let textCoding = NO_CODING;
    let htmlCoding = NO_CODING;

    const walk = (node: MessageStructureObject, depth: number): void => {
        // A message inside a message is a forward. Its parts are addressable and
        // are worth listing as attachments, but its text is not this message's
        // text - taking it would show the forwarded message's first line as the
        // snippet of the forward.
        const type = (node.type ?? "").toLowerCase();
        const part = node.part ?? "";

        if (node.childNodes && node.childNodes.length > 0) {
            for (const child of node.childNodes) walk(child, depth + 1);
            return;
        }

        const disposition = (node.disposition ?? "").toLowerCase();
        const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? "";
        const contentId = (node.id ?? "").replace(/^<+/, "").replace(/>+$/, "");
        // Attached rather than part of the body: said so explicitly, or it has a
        // filename and is not one of the two body types.
        const isFile =
            disposition === "attachment" ||
            (Boolean(filename) && type !== "text/plain" && type !== "text/html") ||
            (disposition === "inline" && Boolean(filename) && !contentId);

        if (!isFile && type === "text/plain" && !textPart) {
            textPart = part || WHOLE_BODY;
            textCoding = codingOf(node);
            return;
        }
        if (!isFile && type === "text/html" && !htmlPart) {
            htmlPart = part || WHOLE_BODY;
            htmlCoding = codingOf(node);
            return;
        }
        if (!part) return;
        if (isFile || contentId) {
            attachments.push({
                part,
                name: filename || fallbackName(type, part),
                contentType: type || "application/octet-stream",
                size: node.size ?? 0,
                contentId,
                // A part the body refers to is drawn by the message; one with no
                // Content-Id and an inline disposition is still a file as far as
                // a reader is concerned.
                inline: Boolean(contentId) && disposition !== "attachment"
            });
        }
    };

    walk(structure, 0);
    // A message with no multipart structure at all: one node, no part number.
    if (!textPart && !htmlPart && !structure.childNodes) {
        const type = (structure.type ?? "").toLowerCase();
        if (type === "text/html") {
            htmlPart = WHOLE_BODY;
            htmlCoding = codingOf(structure);
        } else {
            textPart = WHOLE_BODY;
            textCoding = codingOf(structure);
        }
    }
    return {
        textPart,
        htmlPart,
        textCoding,
        htmlCoding,
        attachments,
        hasAttachments: attachments.some((entry) => !entry.inline)
    };
}

/** Something to call a part that arrived without a filename. Better than the
 *  blank a reader would otherwise be offered as a download. */
function fallbackName(contentType: string, part: string): string {
    const subtype = contentType.split("/")[1] ?? "bin";
    return `part-${part}.${subtype.split("+")[0] ?? "bin"}`;
}
