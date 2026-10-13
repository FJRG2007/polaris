"use server";

/**
 * The first-run tour, remembered per account so it is offered once on whichever
 * device the account first signs in from, and never again after that - taken,
 * finished or skipped. Kept in the per-account marks table beside the badges.
 *
 * Silent both ways: an offer is not worth an error on screen, and a mark that
 * failed to write only means the browser's own note is what stops a repeat.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { backgroundUser } from "@/lib/session";
import { OVERVIEW_MARK_KEY, OVERVIEW_OUTCOMES } from "@/lib/tours/registry";

/** Whether this account has never been offered the overview. Somebody viewing as
 *  another account is never offered one on their behalf. */
export async function shouldOfferOverviewAction(): Promise<boolean> {
    const user = await backgroundUser();
    if (!user || user.viewingAs) return false;
    const row = await prisma.userBadgeSeen
        .findUnique({
            where: { userId_key: { userId: user.id, key: OVERVIEW_MARK_KEY } },
            select: { mark: true }
        })
        .catch(() => ({ mark: "unknown" }));
    return row === null;
}

const outcomeSchema = z.enum(OVERVIEW_OUTCOMES);

export async function markOverviewAction(outcome: unknown): Promise<void> {
    const user = await backgroundUser();
    if (!user || user.viewingAs) return;
    const parsed = outcomeSchema.safeParse(outcome);
    if (!parsed.success) return;
    await prisma.userBadgeSeen
        .upsert({
            where: { userId_key: { userId: user.id, key: OVERVIEW_MARK_KEY } },
            update: { mark: parsed.data },
            create: { userId: user.id, key: OVERVIEW_MARK_KEY, mark: parsed.data }
        })
        .catch(() => undefined);
}
