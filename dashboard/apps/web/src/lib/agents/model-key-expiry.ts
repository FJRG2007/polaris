/**
 * Telling somebody their provider key is about to run out, and again when it has.
 *
 * A key given an end date is one whose owner already knows it will stop working;
 * what they will not know is the morning it does, because the first sign is a run
 * failing for a reason that reads like anything else. So Polaris says it a week
 * ahead, and again on the day, and stops handing the key to runs by itself -
 * which is the part that makes the date worth entering rather than a note in a
 * password manager.
 *
 * Each step is announced once. The row records which announcement it has had, and
 * pushing the date out clears it, so a key that was renewed starts over rather
 * than staying quiet because it was once nearly out.
 *
 * A key with no owner is the deployment's own, and the deployment has no inbox:
 * those go to every administrator, since whoever opens the dashboard first is the
 * one who can replace it.
 */

import { prisma, VISIBLE_USER } from "@polaris/db";
import { notify } from "@/lib/notifications/dispatch";
import { modelProviderName } from "@/lib/agents/model-key-providers";

/** How long before the date the first warning goes out. A week is enough to
 *  create a replacement key at the provider without being so early that it is
 *  forgotten by the time it matters. */
export const EXPIRY_WARNING_DAYS = 7;

const DAY_MS = 86_400_000;

/** Where a key stands against its own end date. */
export type ExpiryPhase = "" | "soon" | "expired";

/** Which announcement a key is due, given the moment. Empty means none: either it
 *  has no date, or the date is far enough away that saying anything would be
 *  noise somebody learns to ignore. */
export function expiryPhase(expiresAt: Date | null, now: Date): ExpiryPhase {
    if (!expiresAt) return "";
    const remaining = expiresAt.getTime() - now.getTime();
    if (remaining <= 0) return "expired";
    return remaining <= EXPIRY_WARNING_DAYS * DAY_MS ? "soon" : "";
}

/** How many whole days are left, for a sentence that says it in the words a
 *  person would use. */
function daysLeft(expiresAt: Date, now: Date): number {
    return Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS));
}

/** Nothing here is worth a long scan: only rows with a date, only ones already
 *  inside the warning window, and a ceiling in case a deployment has thousands. */
const BATCH = 500;

/** Who hears about one key: its owner, or every administrator when it is the
 *  deployment's. Read per row rather than once, because a sweep that matches
 *  nothing should not have gone looking for administrators at all. */
async function recipients(userId: string | null): Promise<string[]> {
    if (userId) return [userId];
    try {
        const admins = await prisma.user.findMany({
            where: { isAdmin: true, ...VISIBLE_USER },
            select: { id: true }
        });
        return admins.map((admin) => admin.id);
    } catch {
        // A deployment nobody can be found in is not a reason to leave the row
        // marked as announced: it is told again on the next pass.
        return [];
    }
}

/**
 * One pass over the keys with an end date.
 *
 * Safe to call on every watcher tick: it reads by an indexed date, and on a
 * deployment where nobody has set an expiry it matches no rows at all.
 */
export async function sweepExpiringModelKeys(now = new Date()): Promise<void> {
    const horizon = new Date(now.getTime() + EXPIRY_WARNING_DAYS * DAY_MS);
    const rows = await prisma.userModelKey.findMany({
        where: { expiresAt: { not: null, lte: horizon } },
        select: { id: true, userId: true, name: true, provider: true, expiresAt: true, expiryNotice: true },
        orderBy: { expiresAt: "asc" },
        take: BATCH
    });

    for (const row of rows) {
        const phase = expiryPhase(row.expiresAt, now);
        if (phase === "" || phase === row.expiryNotice) continue;

        const provider = modelProviderName(row.provider);
        const expiring = phase === "soon" && row.expiresAt;
        const mine = row.userId !== null;
        const whose = mine ? "Your" : "The deployment's";
        const href = mine ? "/account/ai-keys" : "/admin/integrations/models";
        const fallback = mine
            ? "Runs fall back to the next key in your list, or to the deployment's."
            : "Runs fall back to the next key in the list, or to whatever each account brought itself.";
        // Nobody to tell is not the same as nothing to say: the row is left
        // alone so the next pass tries again, rather than recorded as announced
        // to an empty room.
        const told = await recipients(row.userId);
        if (told.length === 0) continue;

        await Promise.all(
            told.map((userId) =>
                notify({
                    userId,
                    event: expiring ? "account.aiKey.expiring" : "account.aiKey.expired",
                    title: expiring
                        ? `${whose} ${provider} key "${row.name}" expires soon`
                        : `${whose} ${provider} key "${row.name}" expired`,
                    body: expiring
                        ? `${daysLeft(row.expiresAt as Date, now)} day(s) left. Replace the key here and runs keep working; leave it and they stop on the day.`
                        : `It is no longer used. ${fallback}`,
                    audience: mine ? undefined : "admins",
                    href
                })
            )
        );

        // Written after the announcement, so a failure to send is retried on the
        // next pass rather than being recorded as delivered.
        await prisma.userModelKey.update({ where: { id: row.id }, data: { expiryNotice: phase } });
    }
}
