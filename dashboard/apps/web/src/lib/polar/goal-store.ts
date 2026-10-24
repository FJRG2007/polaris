/**
 * Where a chat's `/goal` (`goals.ts`) is kept: on its thread, as one JSON
 * value. Owner-scoped: every read and write names the user, and another
 * person's thread reads as having no goal.
 *
 * Server-only.
 */

import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@polaris/db";
import { newGoal, readGoal, type PolarGoal } from "@/lib/polar/goals";

export async function polarGoal(userId: string, threadId: string): Promise<PolarGoal | null> {
    const row = await prisma.polarThread.findFirst({
        where: { id: threadId, userId },
        select: { goal: true }
    });
    return readGoal(row?.goal);
}

/** Sets the chat's goal, replacing any it had. Null for a thread not theirs. */
export async function setPolarGoal(
    userId: string,
    threadId: string,
    condition: string,
    now = Date.now()
): Promise<PolarGoal | null> {
    const goal = newGoal(randomUUID(), condition, now);
    const { count } = await prisma.polarThread.updateMany({
        where: { id: threadId, userId },
        data: { goal: goal as unknown as Prisma.InputJsonValue }
    });
    return count > 0 ? goal : null;
}

/** Removes the chat's goal; the one removed, or null when there was none. */
export async function clearPolarGoal(userId: string, threadId: string): Promise<PolarGoal | null> {
    const goal = await polarGoal(userId, threadId);
    if (!goal) return null;
    await prisma.polarThread.updateMany({
        where: { id: threadId, userId },
        data: { goal: Prisma.DbNull }
    });
    return goal;
}

/** Writes `next` only while the thread still holds the goal it came from. */
export async function savePolarGoal(
    userId: string,
    threadId: string,
    next: PolarGoal
): Promise<boolean> {
    const { count } = await prisma.polarThread.updateMany({
        where: { id: threadId, userId, goal: { path: ["id"], equals: next.id } },
        data: { goal: next as unknown as Prisma.InputJsonValue }
    });
    return count > 0;
}
