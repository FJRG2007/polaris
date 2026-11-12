/**
 * Where the update timing lives: one row in the settings table, so the start of
 * a run survives the dashboard being replaced halfway through it - which every
 * update does - and the history is the same for every container serving.
 */

import { getSetting, swapSetting } from "@/lib/setting-store";
import {
    estimateUpdateMs,
    parseUpdateTiming,
    settleUpdateTiming,
    type RunOutcome,
    type UpdateRunTiming,
    type UpdateTiming
} from "@/lib/update-timing";

const TIMING_KEY = "updates.timing";

/** Conditional writes lost to another container are read again this often. */
const ATTEMPTS = 3;

function runningBuild(): string | null {
    return (process.env.POLARIS_BUILD_SHA ?? "").trim() || null;
}

/** Rewrite the row from what it holds now; a lost race reads it again. */
async function change(next: (timing: UpdateTiming) => UpdateTiming | null): Promise<UpdateTiming> {
    for (let attempt = 0; ; attempt += 1) {
        const raw = await getSetting(TIMING_KEY);
        const timing = parseUpdateTiming(raw);
        const changed = next(timing);
        if (!changed) return timing;
        if (await swapSetting(TIMING_KEY, raw, JSON.stringify(changed))) return changed;
        if (attempt + 1 >= ATTEMPTS) return timing;
    }
}

/** Note that an update was accepted just now, by the build serving now. */
export async function markUpdateStarted(now = Date.now()): Promise<void> {
    await change((timing) => ({ ...timing, run: { startedAt: now, from: runningBuild() } }));
}

/**
 * Close the run if it has landed or failed, and say what is still running.
 * Called by everything that polls during an update and by the watcher's tick,
 * so an update nobody watched is measured too.
 */
export async function currentUpdateRun(outcome: RunOutcome | null): Promise<UpdateRunTiming | null> {
    const now = Date.now();
    const timing = await change((stored) => settleUpdateTiming(stored, runningBuild(), outcome, now));
    if (!timing.run) return null;
    return { startedAt: timing.run.startedAt, estimateMs: estimateUpdateMs(timing.history) };
}
