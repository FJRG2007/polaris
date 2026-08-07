/**
 * What a server is running, and what is eating it.
 *
 * One SSH round trip answers both questions, because they are asked together: the
 * servers list wants the operating system, and the panel behind a row wants where
 * the CPU, memory and disk went. Opening two sessions to ask a small machine two
 * questions is the kind of thing that makes a dashboard the reason a box is busy.
 *
 * The probe is POSIX `sh` fed on stdin, the same way the rest of Polaris talks to a
 * server: sshd runs a command line through a login shell where it is visible in
 * `ps` to every account on the machine, and a script arriving on stdin is not. The
 * script itself and the parser live in `server-probe`, which has no dependencies so
 * both can be exercised against a real machine.
 */

import { prisma } from "@polaris/db";
import { execCommand } from "@polaris/ssh";
import { borrowSsh } from "@/lib/connection-pool";
import { getHostConnection } from "@/lib/host-service";
import { parseProbe, PROBE, type ServerMetrics } from "@/lib/server-probe";

/** Long enough that clicking between servers does not re-probe, short enough that
 *  what the panel shows is still what is happening. */
const CACHE_TTL_MS = 30_000;

/** How long the probe may take before the machine is called unreachable. A shell
 *  that has not answered `uname` in this long is not going to. */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * How old a cached reading may be and still be worth putting on screen while a
 * fresh one is fetched. Far longer than the TTL above, which decides when to probe
 * again: a reading from twenty minutes ago, labelled as such, is worth more on
 * arriving at a page than an empty panel that fills in two seconds later.
 */
const PAINT_MAX_AGE_MS = 3_600_000;

/** In-process cache. A dashboard open on the servers list polls, and every poll
 *  is an SSH session on somebody's machine. */
const cache = new Map<string, { at: number; metrics: ServerMetrics }>();

/**
 * The last reading of this machine, if one was taken recently enough to show, and
 * without probing it. What a server's page renders before its own request leaves,
 * so the panel arrives with figures rather than with skeletons - including on a
 * first visit, where the browser is holding nothing to paint from.
 *
 * Not owner-scoped, because it takes no connection and reads nothing: the caller
 * has to have resolved the server as theirs to have its id at all.
 */
export function peekServerMetrics(hostId: string): { at: number; metrics: ServerMetrics } | null {
    const hit = cache.get(hostId);
    return hit && Date.now() - hit.at < PAINT_MAX_AGE_MS ? hit : null;
}

/**
 * Probe a server, or hand back what it said a moment ago.
 *
 * Owner-scoped through `getHostConnection`, so this cannot be used to read a
 * machine the caller does not have.
 */
export async function getServerMetrics(
    hostId: string,
    ownerId: string,
    force = false
): Promise<ServerMetrics> {
    const hit = cache.get(hostId);
    if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.metrics;

    const connection = await getHostConnection(hostId, ownerId);
    // Borrowed rather than opened: a probe is one short command, and paying a
    // handshake for it is most of what the probe costs.
    const lease = await borrowSsh("exec", hostId, {
        host: connection.address,
        port: connection.port,
        username: connection.username,
        auth: connection.auth,
        // An empty array is "pinning required, nothing known", which is refused.
        // Leaving this undefined would silently trust whatever answered.
        pinnedHostKey: connection.hostKey ?? [],
        readyTimeoutMs: PROBE_TIMEOUT_MS
    });

    let output = "";
    try {
        await execCommand(lease.client, "sh -s", {
            input: PROBE,
            onStdout: (chunk) => {
                output += chunk.toString("utf8");
            }
        });
    } finally {
        lease.release();
    }

    const metrics = parseProbe(output);
    cache.set(hostId, { at: Date.now(), metrics });

    // Recorded so the list can say what a server is without waiting for it, and
    // keeps saying it while the server is down.
    if (metrics.os) {
        await prisma.host.update({
            where: { id: hostId },
            data: { os: metrics.os, osProbedAt: new Date() }
        });
    }
    return metrics;
}
