/**
 * Knocking on a port from outside, and where to knock.
 *
 * Shared because two things ask the same question of the same router: a game
 * server's published port, and the port a call's media arrives on. The answer is
 * only ever positive evidence - a probe leaves this box and comes back in
 * through the operator's own router, and plenty of them will not route their
 * public address back inward, so silence proves nothing at all.
 *
 * Server-only.
 */

import { connect } from "node:net";
import { detectPublicIp } from "@/lib/network-service";
import { isCarrierGradeNat, isPublicIpv4 } from "@polaris/core";

/** How long to wait on a port before calling the probe inconclusive. */
export const PROBE_TIMEOUT_MS = 4000;

/**
 * Try to open the port from here, through the public address.
 *
 * A connection that completes went out to the public address and came back in,
 * which is the forward working. A refusal or a timeout is reported as false and
 * means nothing on its own.
 */
export function probeTcpPort(
    host: string,
    port: number,
    timeoutMs = PROBE_TIMEOUT_MS
): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host, port, timeout: timeoutMs });
        const settle = (reached: boolean): void => {
            socket.destroy();
            resolve(reached);
        };
        socket.once("connect", () => settle(true));
        socket.once("timeout", () => settle(false));
        socket.once("error", () => settle(false));
    });
}

/** The address to knock on: what this network reaches the internet from, and only
 *  when it is one an outside client could use. A carrier-NAT address is shared
 *  with other customers, so what answers on it need not be this machine at all. */
export async function publicProbeHost(): Promise<string | null> {
    const ip = await detectPublicIp().catch(() => null);
    if (!ip || !isPublicIpv4(ip) || isCarrierGradeNat(ip)) return null;
    return ip;
}
