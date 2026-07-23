/**
 * Periodically probes every enabled domain so its reachability stays fresh in the
 * UI and available to Watch alarms. Same shape as the auto-deploy poller: an
 * idempotent start guard, an unref'd interval, and a delayed first pass so it
 * never competes with boot. A bad tick only logs.
 */

import { probeAllDomains } from "@/lib/watch/health-probe";

const INTERVAL_MS = Number(process.env.POLARIS_HEALTH_POLL_MS) || 60_000;
const FIRST_PASS_MS = 20_000;

let started = false;

export async function pollDomainHealth(): Promise<void> {
    await probeAllDomains();
}

export function startDomainHealthPoller(): void {
    if (started) return;
    started = true;
    const tick = (): void => {
        void pollDomainHealth().catch((error) => console.error("polaris: domain health poll failed:", error));
    };
    setTimeout(tick, FIRST_PASS_MS).unref();
    setInterval(tick, INTERVAL_MS).unref();
}
