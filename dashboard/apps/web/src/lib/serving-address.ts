/**
 * The public address visitors of this server's domains are meant to arrive at.
 *
 * Normally the line's own. While backup access holds the records, the line's address
 * says nothing about the domain: on a line that takes no visitors it is a shared
 * address nobody can enter by, and the records are on the backup path on purpose.
 */

import { detectPublicIp } from "@/lib/network-service";
import { backupRecordsTarget } from "@/lib/backup-access";

/** What a domain's records should be compared with, or null when no address can be
 *  named: a tunnel's records hold the tunnel, so they can only be seen to exist. */
export async function expectedPublicAddress(force = false): Promise<string | null> {
    const target = await backupRecordsTarget();
    if (target?.kind === "relay") return target.address;
    if (target?.kind === "tunnel") return null;
    return detectPublicIp(force);
}

/** The address to write into a new record. A tunnel holds only the records it took
 *  over, so a new one still names the line, as it did before the tunnel served. */
export async function publishableAddress(): Promise<string | null> {
    const target = await backupRecordsTarget();
    return target?.kind === "relay" ? target.address : detectPublicIp();
}
