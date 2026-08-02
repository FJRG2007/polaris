/**
 * The firewall's background loop. Runs the jails over the edge's access log, keeps
 * the Tor exit list fresh, prunes ban history, and republishes the snapshot the edge
 * guard enforces.
 *
 * In-process on a timer, like the metrics collector, because none of this can be
 * done lazily: a jail is a statement about a window of time, and a window nobody
 * looked at is a ban nobody issued. The tick is deliberately not fast - the guard
 * enforces from memory, so the only thing the interval controls is how long a fresh
 * offender goes unbanned, and paying for a log scan every second to shave that would
 * be a poor trade.
 */

import { runWafJails } from "@/lib/waf-ban-service";
import { runSshJails } from "@/lib/waf-ssh-service";
import { publishWafIntel, pruneWafBans, refreshWafFeeds } from "@/lib/waf-intel-service";

/** How often the log is scanned. Fast enough that a scanner is stopped mid-sweep,
 *  slow enough to be invisible. */
const TICK_MS = 30_000;

/** Ticks between the housekeeping pass (feed refresh, history pruning), which is
 *  hourly work and does not belong on every scan. */
const MAINTENANCE_EVERY_TICKS = 60;

/** Ticks between SSH auth sweeps. Rarer than the HTTP scan because each one opens a
 *  session to every enrolled server: the edge log is already local, a server is not.
 *  Two minutes still stops a credential sweep long before it works through a list. */
const SSH_EVERY_TICKS = 4;

let started = false;

export function startWafSentinel(): void {
    if (started) return;
    started = true;
    let ticks = 0;

    // Publish once at startup so a guard that came up against an empty volume - a
    // fresh install, a recreated container - is enforcing the current bans without
    // waiting out the first tick.
    void publishWafIntel();

    const tick = async () => {
        try {
            await runWafJails();
            if (ticks % SSH_EVERY_TICKS === 0) await runSshJails();
            if (ticks % MAINTENANCE_EVERY_TICKS === 0) {
                await refreshWafFeeds();
                await pruneWafBans();
            }
        } catch (error) {
            console.error("polaris: the firewall sentinel tick failed:", error);
        } finally {
            ticks += 1;
        }
    };

    const timer = setInterval(() => void tick(), TICK_MS);
    // Never hold the process open for this: it is maintenance, not work anyone is
    // waiting on.
    timer.unref?.();
    void tick();
}
