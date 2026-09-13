/**
 * The apps signed in to a vault, as their owner can recognise them.
 *
 * A client says who it is when it signs in - a name and a type number - and that
 * is stored so somebody can look at the list and account for every row. The vault
 * surface already answers this list to clients (`api/devices`); this is the same
 * rows for a screen, which is where the question "is one of these the browser
 * extension" actually gets asked.
 *
 * Both the name and the type are the CLIENT's claim about itself, never something
 * Polaris verified, and neither is a credential: what a row is for is recognising
 * something unexpected, and the thing to do about a row you do not recognise is
 * change the master password, because a device cannot be locked out of a vault it
 * already holds the key for.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

export interface VaultClientRow {
    readonly id: string;
    /** What the client called itself. */
    readonly name: string;
    /** How Polaris names the type it reported. */
    readonly label: string;
    /** Which sort of client it is, so extensions can be picked out of the list. */
    readonly kind: core.VaultClientKind;
    readonly firstSeenAt: string;
    /** When it last asked this vault for anything. */
    readonly lastSeenAt: string;
}

/**
 * Every client signed in to this account's vault, most recently active first.
 *
 * The device identifier is deliberately left out. It is the only value here a
 * client chose for itself rather than reported about itself, it means nothing to
 * the person reading the list, and a screen should not publish an id it has no use
 * for.
 */
export async function listVaultClients(userId: string): Promise<VaultClientRow[]> {
    const rows = await prisma.vaultDevice.findMany({
        where: { userId },
        orderBy: { revisionDate: "desc" },
        select: { id: true, name: true, type: true, createdAt: true, revisionDate: true }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        label: core.deviceTypeLabel(row.type),
        kind: core.vaultClientKind(row.type),
        firstSeenAt: row.createdAt.toISOString(),
        lastSeenAt: row.revisionDate.toISOString()
    }));
}
