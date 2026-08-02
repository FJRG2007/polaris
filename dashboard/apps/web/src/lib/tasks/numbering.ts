/**
 * Handing out task references.
 *
 * The counter lives on the space and is incremented inside whatever transaction
 * is inserting the task, so two people creating work at the same moment are
 * handed two numbers rather than one number twice. Shared by the task service
 * and the automation engine so neither can drift into a second numbering scheme.
 */

import type { Prisma } from "@polaris/db";

/** The next number for a space, already reserved. Call inside a transaction. */
export async function nextTaskNumber(
    tx: Prisma.TransactionClient,
    spaceId: string
): Promise<{ number: number; prefix: string }> {
    const space = await tx.taskSpace.update({
        where: { id: spaceId },
        data: { taskCounter: { increment: 1 } },
        select: { taskCounter: true, prefix: true }
    });
    return { number: space.taskCounter, prefix: space.prefix };
}
