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

    const walk = (node: MessageStructureObject, parent: string): void => {
        const type = (node.type ?? "").toLowerCase();
        // IMAP numbers the parts of a multipart message from 1 and gives the
        // message itself no number. A message that is not multipart is one part,
        // and that part is "1" - which is how a scanner's PDF, sent as the whole
        // message with nothing around it, is downloaded.
        const part = node.part ?? (node === structure ? "1" : "");
        const disposition = (node.disposition ?? "").toLowerCase();
        const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? "";
        const contentId = (node.id ?? "").replace(/^<+/, "").replace(/>+$/, "");

        // A message inside a message is a forward, and it is ONE file: the .eml
        // somebody attached. imapflow hands it over with the forwarded message's
        // own parts as children, and walking into them listed its pieces instead
        // of it - and took its text for this message's body when this one only
        // had HTML.
        if (type === "message/rfc822" && part) {
            attachments.push({
                part,
                name: filename || forwardedName(node),
                contentType: type,
                size: node.size ?? 0,
                contentId,
                inline: false
            });
            return;
        }

        if (node.childNodes && node.childNodes.length > 0) {
            for (const child of node.childNodes) walk(child, type);
            return;
        }

        // Attached rather than part of the body: said so explicitly, or it has a
        // filename and is not one of the two body types.
        const isFile =
            disposition === "attachment" ||
            (Boolean(filename) && type !== "text/plain" && type !== "text/html") ||
            (disposition === "inline" && Boolean(filename) && !contentId);

        if (!isFile && type === "text/plain" && !textPart) {
            textPart = node.part ?? WHOLE_BODY;
            textCoding = codingOf(node);
            return;
        }
        if (!isFile && type === "text/html" && !htmlPart) {
            htmlPart = node.part ?? WHOLE_BODY;
            htmlCoding = codingOf(node);
            return;
        }
        // A text part that is not the body: a second one with a name is a file
        // somebody attached (notes.txt, page.html), not something to drop.
        const namedText = Boolean(filename) && (type === "text/plain" || type === "text/html");
        // The whole message being one picture or one document, with no name.
        const wholeFile = node === structure && !type.startsWith("text/");
        if (!part) return;
        if (isFile || contentId || namedText || wholeFile) {
            attachments.push({
                part,
                name: filename || fallbackName(type, part),
                contentType: type || "application/octet-stream",
                size: node.size ?? 0,
                contentId,
                inline: isDrawnInline({ type, contentId, disposition, parent })
            });
        }
    };

    walk(structure, "");
    // A message with no multipart structure at all: one node, no part number.
    // Unless that one node is a file, in which case it has no text to read and
    // reading its bytes as the body would show a PDF as a page of noise.
    if (!textPart && !htmlPart && !structure.childNodes && attachments.length === 0) {
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

/**
 * Whether a part is a picture the message draws itself with, rather than a file.
 *
 * A Content-Id alone is not the answer, and it was: Apple Mail and the phone
 * apps give every attachment a Content-Id and an `inline` disposition, so a PDF
 * or a photo somebody attached from an iPhone was filed as part of the body,
 * kept off the list of files, and - since the reader never draws `cid:` pictures
 * - shown nowhere at all. What a message actually draws is a picture inside a
 * `multipart/related`, the one container that means "these parts belong to the
 * HTML beside them".
 */
export function isDrawnInline(part: {
    readonly type: string;
    readonly contentId: string;
    readonly disposition: string;
    readonly parent: string;
}): boolean {
    return (
        Boolean(part.contentId) &&
        part.disposition !== "attachment" &&
        part.type.startsWith("image/") &&
        part.parent === "multipart/related"
    );
}

/** A name for an attached message that came with none: its subject, as a file. */
function forwardedName(node: MessageStructureObject): string {
    const subject = (node.envelope?.subject ?? "").replace(/[\\/:*?"<>|\r\n]+/g, " ").trim();
    return `${subject.slice(0, 80) || "Forwarded message"}.eml`;
}

/** Something to call a part that arrived without a filename. Better than the
 *  blank a reader would otherwise be offered as a download. */
function fallbackName(contentType: string, part: string): string {
    const subtype = contentType.split("/")[1] ?? "bin";
    return `part-${part}.${subtype.split("+")[0] ?? "bin"}`;
}
