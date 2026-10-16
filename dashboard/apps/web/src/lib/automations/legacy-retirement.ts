/**
 * When the old Places and CRM automation tables may go (phase 7), decided on
 * this install from what is on it - never from a version number.
 *
 * Installs skip versions: one boot can apply every migration from an old
 * Polaris to the release that retires the old engines. So retiring is not a
 * SQL migration. It is a boot step that asks `legacyRetirementVerdict`, and
 * keeps the tables (retrying on a later boot) unless every condition holds:
 *
 * - every old row has a central counterpart, counted;
 * - no old run is still waiting on the old engine;
 * - a marker records that the move finished;
 * - the new engine has run for `RETIRE_AFTER_MS` since that marker;
 * - at least one boot happened after the boot that set the marker.
 *
 * Fourteen days: two full weekly cycles, so a weekly schedule has fired on the
 * new engine at least twice and the old one-week waits have drained. Longer
 * waits (CRM, up to 30 days) are covered by the "no old run waiting" count.
 *
 * Phase 0 ships the verdict and starts the engine's own clock (`noteEngineBoot`)
 * so the time is measured from when the engine really started on the install.
 */

import { prisma } from "@polaris/db";

export const RETIRE_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export const ENGINE_FIRST_BOOT_KEY = "automations.engine.firstBootAt";
export const ENGINE_BOOTS_KEY = "automations.engine.boots";

export interface RetirementFacts {
    /** Rows in the old table, and how many of them have a central counterpart. */
    readonly sourceRows: number;
    readonly movedRows: number;
    /** Old runs still waiting on the old engine. */
    readonly oldRunsWaiting: number;
    /** When the move-finished marker was set, and the boot count at that moment. */
    readonly markerAt: Date | null;
    readonly bootsAtMarker: number | null;
    /** The engine's boot count now, this boot included. */
    readonly boots: number;
    readonly now: Date;
}

export type RetirementVerdict =
    | { readonly retire: true }
    | {
          readonly retire: false;
          readonly reason: "rowsLeft" | "runsWaiting" | "noMarker" | "tooSoon" | "noLaterBoot";
      };

export function legacyRetirementVerdict(facts: RetirementFacts): RetirementVerdict {
    if (facts.movedRows < facts.sourceRows) return { retire: false, reason: "rowsLeft" };
    if (facts.oldRunsWaiting > 0) return { retire: false, reason: "runsWaiting" };
    if (!facts.markerAt || facts.bootsAtMarker === null)
        return { retire: false, reason: "noMarker" };
    if (facts.now.getTime() - facts.markerAt.getTime() < RETIRE_AFTER_MS)
        return { retire: false, reason: "tooSoon" };
    if (facts.boots <= facts.bootsAtMarker) return { retire: false, reason: "noLaterBoot" };
    return { retire: true };
}

let noted = false;

/** Count this process's boot once, and stamp the engine's first boot on the install. Idempotent per process. */
export async function noteEngineBoot(): Promise<void> {
    if (noted) return;
    noted = true;
    try {
        await prisma.setting.upsert({
            where: { key: ENGINE_FIRST_BOOT_KEY },
            create: {
                key: ENGINE_FIRST_BOOT_KEY,
                value: new Date().toISOString(),
                scope: "global"
            },
            update: {}
        });
        const boots = await prisma.setting.findUnique({
            where: { key: ENGINE_BOOTS_KEY },
            select: { value: true }
        });
        const count = Number(boots?.value ?? "0") || 0;
        await prisma.setting.upsert({
            where: { key: ENGINE_BOOTS_KEY },
            create: { key: ENGINE_BOOTS_KEY, value: String(count + 1), scope: "global" },
            update: { value: String(count + 1) }
        });
    } catch (caught) {
        noted = false;
        console.error("polaris: could not record the automations engine boot:", caught);
    }
}
