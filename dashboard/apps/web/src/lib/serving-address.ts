/**
 * The public address visitors of this server's domains are meant to arrive at.
 *
 * Normally the line's own. While backup access holds the records, the line's address
 * says nothing about the domain: on a line that takes no visitors it is a shared
 * address nobody can enter by, and the records are on the backup path on purpose.
 */

import { detectPublicIp } from "@/lib/network-service";
import { getSetting } from "@/lib/setting-store";
import { backupRecordsTarget } from "@/lib/backup-access";
import { INBOUND_KEY, mayPublish, readReach } from "@/lib/backup-access/inbound";

/** What the records backup access holds should be compared with, or null when no
 *  address can be named: a tunnel's records hold the tunnel, so they can only be seen
 *  to exist. */
export async function expectedPublicAddress(force = false): Promise<string | null> {
    const target = await backupRecordsTarget();
    if (target?.kind === "relay") return target.address;
    if (target?.kind === "tunnel") return null;
    return detectPublicIp(force);
}

/** Every address a name outside backup access's records may hold and still be right:
 *  a flip moves only the base zone's names, so the others stay on the line. */
export async function acceptedAddresses(): Promise<string[]> {
    const [target, line] = await Promise.all([
        backupRecordsTarget(),
        detectPublicIp().catch(() => null)
    ]);
    const relay = target?.kind === "relay" ? target.address : null;
    return [...new Set([relay, line])].filter((address) => address !== null);
}

/** The line's address, unless it is known to take no visitors. */
async function visitableLine(): Promise<string | null> {
    const [ip, reach] = await Promise.all([
        detectPublicIp(),
        getSetting(INBOUND_KEY).catch(() => null)
    ]);
    if (!ip) return null;
    return mayPublish({ ip, reach: readReach(reach), backupServing: false }).publish ? ip : null;
}

/** The address to write into a new record. A tunnel holds only the records it took
 *  over, so a new one names the line, or nothing when the line takes no visitors. */
export async function publishableAddress(): Promise<string | null> {
    const target = await backupRecordsTarget();
    if (target?.kind === "relay") return target.address;
    return target?.kind === "tunnel" ? visitableLine() : detectPublicIp();
}

/** Where a port published on this machine is reached: always the line, because
 *  neither backup path carries a service's own ports. */
export async function publishedPortAddress(): Promise<string | null> {
    return (await backupRecordsTarget()) ? visitableLine() : detectPublicIp();
}
