/**
 * Where a Polaris account is signed in from right now, as a game server's
 * allow list needs it.
 *
 * A player linked to a Polaris account may only connect from an address that
 * account is signed in from. So the list is read from the sessions themselves,
 * every time, rather than copied once when somebody was added: signing in from a
 * new network opens it, and signing out - or the session expiring or being
 * revoked - closes it.
 *
 * Only a session that is actually in use counts: not expired, seen and let
 * through by Polaris, not waiting for approval or refused, not locked. IPv4 only, because the game servers' address
 * rules are.
 *
 * A session reached over the local network also counts for the network's public
 * address, because somebody at home who opens Polaris on the LAN usually joins
 * the server through its public address.
 */

import { prisma } from "@polaris/db";
import { isIpv4, isPrivateIp } from "@polaris/core";
import { host } from "@polaris/app-host";

const { networkPublicIp } = host.networkService;

const IN_USE = { approval: "approved", lockedAt: null } as const;

/** The addresses each of these accounts is signed in from, by user id. An
 *  account with no usable session has an empty list, never a missing one. */
export async function signInAddresses(userIds: readonly string[]): Promise<Map<string, string[]>> {
    const wanted = [...new Set(userIds)];
    const found = new Map<string, string[]>(wanted.map((id) => [id, []]));
    if (wanted.length === 0) return found;

    const rows = await prisma.session.findMany({
        where: { userId: { in: wanted }, expiresAt: { gt: new Date() }, state: { is: IN_USE } },
        select: { userId: true, ipAddress: true, state: { select: { ip: true } } }
    });

    let publicIp: string | null | undefined;
    for (const row of rows) {
        const ip = (row.state?.ip ?? row.ipAddress ?? "").trim();
        if (!isIpv4(ip)) continue;
        const held = found.get(row.userId) ?? [];
        if (!held.includes(ip)) held.push(ip);
        if (isPrivateIp(ip)) {
            if (publicIp === undefined) publicIp = await networkPublicIp().catch(() => null);
            if (publicIp && isIpv4(publicIp) && !held.includes(publicIp)) held.push(publicIp);
        }
        found.set(row.userId, held);
    }
    return found;
}

/** Whether each of these accounts has a session in use right now. */
export async function signedIn(userIds: readonly string[]): Promise<Set<string>> {
    const wanted = [...new Set(userIds)];
    if (wanted.length === 0) return new Set();
    const rows = await prisma.session.findMany({
        where: { userId: { in: wanted }, expiresAt: { gt: new Date() }, state: { is: IN_USE } },
        select: { userId: true }
    });
    return new Set(rows.map((row) => row.userId));
}
