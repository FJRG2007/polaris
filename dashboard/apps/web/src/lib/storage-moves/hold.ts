/**
 * Services a job has stopped to work on their files, so no storage move takes
 * those files away meanwhile.
 *
 * A world trim or a copy stops its server and then reads or rewrites its volume;
 * to the storage sweep that is a stopped service like any other, and a move it
 * started then would copy the volume and empty the original under the job. Every
 * move starts through `startMove`, which asks here, as the sweep does.
 *
 * Kept in this process, like the copy hold (`apps/install-copy-hold`): a job is a
 * task of it, and one cut short by a restart holds nothing any more.
 *
 * Server-only.
 */

import { heldForCopy } from "@/lib/apps/install-copy-hold";

const held = new Map<string, number>();

/** Hold the given services until `releaseStorage` is called with them. */
export function holdStorage(applicationIds: readonly string[]): void {
    for (const id of new Set(applicationIds)) held.set(id, (held.get(id) ?? 0) + 1);
}

export function releaseStorage(applicationIds: readonly string[]): void {
    for (const id of new Set(applicationIds)) {
        const left = (held.get(id) ?? 1) - 1;
        if (left > 0) held.set(id, left);
        else held.delete(id);
    }
}

/** Whether a job or a copy is working on this service's files right now. */
export function storageHeld(applicationId: string): boolean {
    return held.has(applicationId) || heldForCopy(applicationId);
}
