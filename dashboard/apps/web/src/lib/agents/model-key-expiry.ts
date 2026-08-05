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
 */

import { prisma } from "@polaris/db";
import { notify } from "@/lib/notifications/dispatch";
import { MODEL_INTEGRATIONS } from "@/lib/integrations/registry";

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

function providerName(slug: string): string {
    return MODEL_INTEGRATIONS.find((entry) => entry.slug === slug)?.name ?? slug;
}

/** Nothing here is worth a long scan: only rows with a date, only ones already
 *  inside the warning window, and a ceiling in case a deployment has thousands. */
const BATCH = 500;

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

        const provider = providerName(row.provider);
        const expiring = phase === "soon" && row.expiresAt;
        await notify({
            userId: row.userId,
            event: expiring ? "account.aiKey.expiring" : "account.aiKey.expired",
            title: expiring
                ? `Your ${provider} key "${row.name}" expires soon`
                : `Your ${provider} key "${row.name}" expired`,
            body: expiring
                ? `${daysLeft(row.expiresAt as Date, now)} day(s) left. Replace the key here and runs keep working; leave it and they stop on the day.`
                : "It is no longer used. Runs fall back to the next key in your list, or to the deployment's.",
            href: "/account/ai-keys"
        });

        // Written after the announcement, so a failure to send is retried on the
        // next pass rather than being recorded as delivered.
        await prisma.userModelKey.update({ where: { id: row.id }, data: { expiryNotice: phase } });
    }
}
