/**
 * The address and hardware address of a thing on this network, for a screen.
 *
 * The table is one exec on the host, so it is shared for half a minute: a list
 * polled every few seconds asks once however many rows it has.
 *
 * Server-only.
 */

import { lanDetails, type LanDetails } from "@polaris/core";
import { readNeighbourTable, type NeighbourTable } from "@/lib/storage-whereabouts/neighbours";

const TABLE_MS = 30_000;

let held: { at: number; table: Promise<NeighbourTable> } | null = null;

function neighbours(now = Date.now()): Promise<NeighbourTable> {
    if (held && now - held.at < TABLE_MS) return held.table;
    held = { at: now, table: readNeighbourTable().catch(() => new Map<string, string>()) };
    return held.table;
}

/** What is known of an address as stored. `knownMac` is the one remembered from
 *  the last time the device answered, for when the table has lost it. */
export async function networkDetails(
    stored: string | null | undefined,
    knownMac: string | null = null
): Promise<LanDetails | null> {
    return lanDetails(stored, await neighbours(), knownMac);
}
