/**
 * Pausing the runs nobody started by hand.
 *
 * With the provider out of credit, every pull request opened, every mention and
 * every automation still dispatched a run, each spent a runner to learn it could
 * not be served, and each left a failed job and a comment saying so on the pull
 * request. The operator could only stop that by switching every rule or
 * repository off one at a time, and then remembering which ones to put back.
 *
 * So an account's automatic runs can be paused as a whole, by hand from the
 * Runs page, and Polaris pauses them itself once a run has failed for credit and
 * the fallback chain had nowhere left to go. A run started by hand still starts:
 * that is somebody deciding to spend, which is exactly what the pause is waiting
 * for. Nothing is forgotten while paused - rules and repositories stay as they
 * were, so resuming is one press.
 *
 * Kept in the setting store, keyed by the owner, because an update restarts the
 * process and must not resume anything.
 */

import { z } from "zod";
import type { AgentTrigger } from "@polaris/core";
import { getSetting, setSetting } from "@/lib/setting-store";

/** Why the runs stopped: somebody pressed Pause, or the provider ran out of credit. */
export type AgentPauseReason = "manual" | "credits";

export interface AgentPause {
    readonly reason: AgentPauseReason;
    /** ISO time it started. */
    readonly since: string;
}

/** The failure kinds that mean the account behind the key has no balance left. */
export const CREDIT_FAILURE_KINDS: readonly string[] = ["provider-billing", "router-billing"];

const pauseSchema = z.object({
    reason: z.enum(["manual", "credits"]),
    since: z.string().datetime()
});

const keyFor = (ownerId: string) => `agents.pause.${ownerId}`;

/** The account's pause, or null when its runs start as usual. A stored value that
 *  no longer reads is treated as no pause rather than as a pause nobody can see. */
export async function readAgentPause(ownerId: string): Promise<AgentPause | null> {
    const raw = await getSetting(keyFor(ownerId));
    if (!raw) return null;
    try {
        const parsed = pauseSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

/** Pause the account's automatic runs. An existing pause keeps its reason and time:
 *  a credit pause pressed again by hand is still the credit pause. */
export async function pauseAgentRuns(
    ownerId: string,
    reason: AgentPauseReason,
    now: Date = new Date()
): Promise<AgentPause> {
    const held = await readAgentPause(ownerId);
    if (held) return held;
    const pause: AgentPause = { reason, since: now.toISOString() };
    await setSetting(keyFor(ownerId), JSON.stringify(pause));
    return pause;
}

export async function resumeAgentRuns(ownerId: string): Promise<void> {
    await setSetting(keyFor(ownerId), null);
}

/** Whether a pause stops a run with this trigger: everything but a manual start. */
export function pauseStops(trigger: AgentTrigger): boolean {
    return trigger !== "manual";
}
