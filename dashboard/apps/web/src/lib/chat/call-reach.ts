/**
 * Whether a call can reach this machine from outside.
 *
 * Inside the house it already can: a browser on this network sends media to the
 * machine's own address and nothing is in the way. From outside, the router has
 * to forward the call ports, and until it does a call between somebody at home
 * and somebody on mobile data connects, shows both names and carries no sound.
 * That is the failure this exists to make visible - it is invisible from inside
 * the call, and there is nowhere else in Polaris a router question is answered.
 *
 * Positive evidence only, the same way `reach.ts` treats a game port: a
 * connection that completes went out to the public address and came back in
 * through the router, which is the forward working. Silence means nothing, since
 * plenty of routers will not loop their own address back inward.
 *
 * Server-only.
 */

import { getHostLanIp } from "@/lib/host-address";
import { callServer } from "@/lib/chat/call-server";
import { getSetting, setSetting } from "@/lib/setting-store";
import { probeTcpPort, publicProbeHost } from "@/lib/net/port-probe";
import { CALL_PORTS, CALL_TCP_PORT, type CallPortsReading } from "@/lib/chat/call-ports";

/** Where the proof is kept once there is any. A setting rather than a row: it is
 *  one fact about this deployment, and it outlives every call it was learned in. */
const REACHED_AT = "chat.calls.portsReachableAt";

/** How long a probe's answer stands before the port is worth knocking on again.
 *  A forward is created once and then left alone, and every open panel polls, so
 *  one attempt covers them all. */
const PROBE_EVERY_MS = 30_000;

/** When the last knock went out, per process. A rate limit, not a record. */
let probedAt = 0;

/** Forget the rate limit. For a test that is a different deployment every case;
 *  nothing in the app calls it. */
export function forgetProbe(): void {
    probedAt = 0;
}

/**
 * The call ports as they stand, knocking on the one that can answer when asked.
 *
 * `probe` is off for a render and on for a poll: knocking on a closed port waits
 * out a timeout, and a page must not wait on it to paint.
 */
export async function readCallPorts(probe = false): Promise<CallPortsReading> {
    const [endpoint, lanIp, reachedAt] = await Promise.all([
        callServer(),
        getHostLanIp().catch(() => null),
        getSetting(REACHED_AT)
    ]);

    const base = {
        ports: CALL_PORTS,
        running: endpoint !== null,
        shipped: endpoint?.shipped ?? false,
        lanIp,
        confirmedAt: reachedAt || null,
        confirmed: Boolean(reachedAt)
    };

    // Nothing here is about a server somebody else runs, and nothing can be
    // proven about one that is not up.
    if (!base.shipped || !base.running || base.confirmed || !probe) {
        return { ...base, cannotProbe: null };
    }

    const host = await publicProbeHost();
    if (!host) {
        return {
            ...base,
            cannotProbe:
                "This connection has no public address of its own, so the ports cannot be checked from here. Calls from outside need one."
        };
    }
    if (Date.now() - probedAt < PROBE_EVERY_MS) return { ...base, cannotProbe: null };
    probedAt = Date.now();

    if (!(await probeTcpPort(host, CALL_TCP_PORT))) return { ...base, cannotProbe: null };

    const at = new Date().toISOString();
    await setSetting(REACHED_AT, at);
    return { ...base, confirmed: true, confirmedAt: at, cannotProbe: null };
}
