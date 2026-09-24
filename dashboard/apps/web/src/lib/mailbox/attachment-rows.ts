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
import type { MessageShape } from "./structure";

/** Whether anything had to change. */
export async function reconcileAttachments(
    messageId: string,
    shape: MessageShape
): Promise<boolean> {
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
