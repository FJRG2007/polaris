/**
 * What the last check of each pool server found (see `pool-reach`), read on
 * its own so placement can consult it without the SSH that asks.
 */

import { z } from "zod";
import { getSetting } from "@/lib/setting-store";

export const REACH_KEY = "polar.code.reach";

/** How old an answer may be before the cron asks again. */
export const RECHECK_MS = 10 * 60_000;
/** How long a "cannot reach" keeps a server out of placement without a newer
 *  answer. Past it the server is tried again rather than left out forever on
 *  one old answer. */
export const BLOCKED_HOLDS_MS = 60 * 60_000;

/**
 * - `ok`: it fetched Polaris's health check.
 * - `blocked`: it was asked and could not.
 * - `noTool`: it has neither curl nor wget, so it could not be asked. Not held
 *   against it - the sessions bring their own.
 * - `down`: Polaris could not reach it over SSH. Placement already leaves out a
 *   server that is offline; this only says so on the screen.
 */
export type ReachState = "ok" | "blocked" | "noTool" | "down";

const reachSchema = z.object({
    state: z.enum(["ok", "blocked", "noTool", "down"]),
    at: z.number(),
    url: z.string().max(2048)
});

export type Reach = z.infer<typeof reachSchema>;

export async function readReach(): Promise<Record<string, Reach>> {
    const stored = await getSetting(REACH_KEY).catch(() => null);
    if (!stored) return {};
    try {
        const parsed = z.record(z.string(), reachSchema).safeParse(JSON.parse(stored));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
}

/** Whether placement should leave this server out for now. */
export function reachBlocked(reach: Reach | undefined, now = Date.now()): boolean {
    return reach?.state === "blocked" && now - reach.at < BLOCKED_HOLDS_MS;
}
