/**
 * Which services are being flooded right now, as the flood check last saw it.
 *
 * Only the "auto" challenge reads this. It is a decision rather than an observation -
 * once a service is marked, it stays marked for a while even if the next minute is
 * quiet, because an attack that pauses for a minute is still an attack and a challenge
 * that flaps on and off is a site that keeps interrupting its visitors. So the state is
 * stored, with an expiry per service, instead of recomputed on every read.
 *
 * Kept apart from the watcher that writes it so the deploy plan and the route renderer
 * can ask the question without importing the edge log, and without the import cycle
 * the watcher would otherwise make with the service that re-renders the edge.
 */

import type { EdgeChallengeMode } from "@polaris/core";
import { getSetting, setSetting } from "@/lib/setting-store";

const KEY = "deploy.flooded";

/** Service id to the moment its challenge lifts, epoch ms. Entries already past are
 *  dropped on read, so an old row never keeps a service challenged. */
export async function floodedServices(now = Date.now()): Promise<Map<string, number>> {
    const raw = await getSetting(KEY);
    const out = new Map<string, number>();
    if (!raw) return out;
    try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        for (const [id, until] of Object.entries(parsed)) {
            if (typeof until === "number" && until > now) out.set(id, until);
        }
    } catch {
        // An unreadable value marks nothing.
    }
    return out;
}

export async function saveFloodedServices(state: ReadonlyMap<string, number>): Promise<void> {
    await setSetting(KEY, JSON.stringify(Object.fromEntries(state)));
}

/** Whether a service's visitors are being challenged right now: always when its owner
 *  switched it on, and while the flood check has it marked when set to "auto". */
export async function challengeActive(
    serviceId: string,
    mode: EdgeChallengeMode,
    flooded?: ReadonlyMap<string, number>
): Promise<boolean> {
    if (mode === "on") return true;
    if (mode !== "auto") return false;
    return (flooded ?? (await floodedServices())).has(serviceId);
}
