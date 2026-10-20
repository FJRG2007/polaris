/**
 * An item dragged onto Polar, made into one of Polar's attachments.
 *
 * Each kind is looked up again here, as the person who dropped it and through
 * the same reader its own app uses: a mail through the owner-narrowed message
 * reader, a Drive file through the storage guard every "attach from Drive"
 * goes through, a chat picture through the conversation's own access check.
 * An item that is not there and one that is not theirs are the same refusal,
 * so a drop cannot be used to find out what exists.
 *
 * What is stored is a copy, kept and swept like any file picked from disk
 * (`attachments.ts`).
 *
 * Server-only.
 */

import { channelAccess } from "@/lib/chat/access";
import { addressesFrom } from "@/lib/mailbox/json";
import * as history from "@/lib/chat/history-visibility";
import { sessionCan, type SessionUser } from "@/lib/session";
import type { DroppedItem } from "@/lib/polar/dropped-items";
import { loadBody, messageForReading } from "@/lib/mailbox/messages";
import { channelOfAttachment, readAttachment } from "@/lib/chat/attachments";
import { AttachRefused, fileFromDrive } from "@/lib/attachments/from-elsewhere";
import {
    acceptedType,
    storePolarAttachment,
    POLAR_ATTACHMENT_MAX_BYTES,
    type PolarAttachmentView
} from "@/lib/polar/attachments";

export type ItemRefusal = "not_found" | "unsupported_type" | "too_large";

export class ItemRefused extends Error {
    constructor(readonly code: ItemRefusal) {
        super(code);
    }
}

/**
 * Text from a mail that only has HTML. Read by a model, never drawn, so tags
 * are dropped rather than interpreted: blocks become line breaks, scripts and
 * styles go with their contents, and the few entities mail is full of are
 * decoded.
 */
export function textFromHtml(html: string): string {
    return html
        .replace(/<(script|style|head)\b[\s\S]*?<\/\1\s*>/gi, " ")
        .replace(/<br\s*\/?>/gi, "\n")
        .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/gi, " ")
        .replace(/&lt;/gi, "<")
        .replace(/&gt;/gi, ">")
        .replace(/&quot;/gi, '"')
        .replace(/&#39;/gi, "'")
        .replace(/&amp;/gi, "&")
        .replace(/[ \t]+/g, " ")
        .replace(/ *\n */g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
}

function addressLine(value: unknown): string {
    return addressesFrom(value)
        .map((entry) => (entry.name ? `${entry.name} <${entry.address}>` : entry.address))
        .join(", ");
}

/** A mail as a plain-text document: its headers, then its text. */
export function mailDocument(input: {
    subject: string | null;
    from: unknown;
    to: unknown;
    cc: unknown;
    sentAt: Date | string;
    text: string;
}): string {
    const sentAt = input.sentAt instanceof Date ? input.sentAt : new Date(input.sentAt);
    const lines = [
        `Subject: ${input.subject ?? ""}`,
        `From: ${addressLine(input.from)}`,
        `To: ${addressLine(input.to)}`
    ];
    const cc = addressLine(input.cc);
    if (cc) lines.push(`Cc: ${cc}`);
    if (!Number.isNaN(sentAt.getTime())) lines.push(`Date: ${sentAt.toISOString()}`);
    return `${lines.join("\n")}\n\n${input.text}`;
}

/** Cut to `max` bytes of UTF-8 without splitting a character. */
function capped(text: string, max: number): Uint8Array {
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= max) return bytes;
    const cut = new TextDecoder().decode(bytes.slice(0, max)).replace(/�$/, "");
    return new TextEncoder().encode(cut);
}

function fileName(subject: string | null): string {
    const base = (subject ?? "").replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").trim().slice(0, 120);
    return `${base || "Message"}.txt`;
}

async function mailAttachment(user: SessionUser, id: string): Promise<PolarAttachmentView> {
    if (!(await sessionCan(user, "mail.use"))) throw new ItemRefused("not_found");
    const message = await messageForReading(user.id, id);
    if (!message) throw new ItemRefused("not_found");
    let text = message.row.bodyText ?? "";
    let html = message.row.bodyHtml ?? "";
    if (!text && !html) {
        const body = await loadBody(user.id, id);
        text = body.text;
        html = body.html;
    }
    const document = mailDocument({
        subject: message.envelope.subject,
        from: message.row.fromJson,
        to: message.envelope.to,
        cc: message.envelope.cc,
        sentAt: message.envelope.sentAt,
        text: text || textFromHtml(html)
    });
    return storePolarAttachment({
        userId: user.id,
        name: fileName(message.envelope.subject),
        mediaType: "text/plain",
        bytes: capped(document, POLAR_ATTACHMENT_MAX_BYTES)
    });
}

async function driveAttachment(
    user: SessionUser,
    connectionId: string,
    path: string
): Promise<PolarAttachmentView> {
    let file;
    try {
        file = await fileFromDrive(user.id, connectionId, path, POLAR_ATTACHMENT_MAX_BYTES);
    } catch (caught) {
        if (caught instanceof AttachRefused) {
            // The guard's sentence says whether it was the size; nothing else of
            // it is shown, it names the storage.
            throw new ItemRefused(/bigger|large|MB/i.test(caught.message) ? "too_large" : "not_found");
        }
        throw caught;
    }
    const mediaType = acceptedType(file.type);
    if (!mediaType) throw new ItemRefused("unsupported_type");
    return storePolarAttachment({ userId: user.id, name: file.name, mediaType, bytes: file.bytes });
}

async function chatAttachment(user: SessionUser, id: string): Promise<PolarAttachmentView> {
    if (!(await sessionCan(user, "chat.use"))) throw new ItemRefused("not_found");
    const channelId = await channelOfAttachment(id);
    if (
        !channelId ||
        !(await channelAccess({ id: user.id }, channelId)) ||
        !(await history.attachmentReadable({ id: user.id }, channelId, id))
    ) {
        throw new ItemRefused("not_found");
    }
    const file = await readAttachment(id);
    if (!file) throw new ItemRefused("not_found");
    const mediaType = acceptedType(file.contentType);
    if (!mediaType) throw new ItemRefused("unsupported_type");
    if (file.bytes.byteLength > POLAR_ATTACHMENT_MAX_BYTES) throw new ItemRefused("too_large");
    return storePolarAttachment({ userId: user.id, name: file.name, mediaType, bytes: file.bytes });
}

/** The dropped item, read as `user` and stored as one of their attachments. */
export async function attachDroppedItem(
    user: SessionUser,
    item: DroppedItem
): Promise<PolarAttachmentView> {
    switch (item.kind) {
        case "mail-message":
            return mailAttachment(user, item.id);
        case "drive-file":
            return driveAttachment(user, item.connectionId, item.path);
        case "chat-attachment":
            return chatAttachment(user, item.id);
    }
}
