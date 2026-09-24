/**
 * Bringing a stored message's files in line with what the server says it has.
 *
 * A message's attachments are written once, when it first arrives, and a
 * resync never touches them again - so a message read by an older reading of
 * its shape keeps that reading for ever: an attached email listed as its pieces,
 * a scanner's PDF with no file at all, an iPhone's attachment hidden as part of
 * the body. Every time the shape is fetched again anyway (a body being brought
 * down, a message being opened) this compares the two and repairs the rows.
 *
 * Rows are kept where they still describe a part, by part number, so a file
 * that was already saved somewhere keeps its record of where.
 */

import { prisma } from "@polaris/db";
import type { MessagePart, MessageShape } from "./structure";

/**
 * The parts, with every picture the HTML actually draws marked as part of it.
 *
 * The shape alone cannot always tell: a newsletter's icons can sit beside the
 * HTML in a `multipart/mixed` with a Content-Id each, exactly the way an iPhone
 * attaches a photo. The body settles it - a picture its HTML asks for by
 * `cid:` is one it draws, and listing it as a file is a paperclip on every
 * newsletter. Only ever narrows: nothing the shape called inline is made a file.
 */
export function drawnByBody(parts: readonly MessagePart[], html: string): MessagePart[] {
    if (!html) return [...parts];
    const body = html.toLowerCase();
    return parts.map((part) =>
        !part.inline &&
        part.contentId &&
        part.contentType.startsWith("image/") &&
        body.includes(`cid:${part.contentId.toLowerCase()}`)
            ? { ...part, inline: true }
            : part
    );
}

/** Whether anything had to change. `html` is the body when it is known, which
 *  decides the pictures it draws - see `drawnByBody`. */
export async function reconcileAttachments(
    messageId: string,
    read: MessageShape,
    html = ""
): Promise<boolean> {
    const attachments = drawnByBody(read.attachments, html);
    const shape = {
        attachments,
        hasAttachments: attachments.some((part) => !part.inline)
    };
    const stored = await prisma.mailAttachment.findMany({
        where: { messageId },
        select: { id: true, part: true, inline: true }
    });
    const byPart = new Map(stored.map((row) => [row.part, row]));
    const wanted = new Set(shape.attachments.map((part) => part.part));

    const gone = stored.filter((row) => !wanted.has(row.part)).map((row) => row.id);
    const added = shape.attachments.filter((part) => !byPart.has(part.part));
    const flipped = shape.attachments.filter((part) => {
        const row = byPart.get(part.part);
        return row !== undefined && row.inline !== part.inline;
    });
    if (gone.length === 0 && added.length === 0 && flipped.length === 0) return false;

    await prisma.$transaction([
        prisma.mailAttachment.deleteMany({ where: { id: { in: gone } } }),
        prisma.mailAttachment.createMany({
            data: added.map((part) => ({
                messageId,
                part: part.part,
                name: part.name,
                contentType: part.contentType,
                size: BigInt(part.size),
                contentId: part.contentId,
                inline: part.inline
            })),
            skipDuplicates: true
        }),
        ...flipped.map((part) =>
            prisma.mailAttachment.update({
                where: { messageId_part: { messageId, part: part.part } },
                data: { inline: part.inline }
            })
        )
    ]);

    // The paperclip, on the message and on its conversation, from the same
    // reading - so the list and the message can never disagree about it.
    const message = await prisma.mailMessage.update({
        where: { id: messageId },
        data: { hasAttachments: shape.hasAttachments },
        select: { threadId: true }
    });
    const anyInThread = await prisma.mailMessage.count({
        where: { threadId: message.threadId, hasAttachments: true },
        take: 1
    });
    await prisma.mailThread.update({
        where: { id: message.threadId },
        data: { hasAttachments: anyInThread > 0 }
    });
    return true;
}
