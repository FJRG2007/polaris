/**
 * Who may look at, and who may drive, one NAS in Places.
 *
 * The NAS is a Drive storage connection: whoever connected it runs it, since
 * the console password it signs in with is theirs. It can be lent like a UPS -
 * to watch (status, storage, history), and per action beyond that: `fan` sets
 * its fan profile, `backup` runs one of its backup tasks. Each act a visitor
 * makes spends one use of the grant that allowed it.
 *
 * Lending never reaches the connection itself: its address, account, shares
 * and Drive settings stay with its owner.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { SessionUser } from "@/lib/session";
import { liveGrants, type LiveGrant } from "@/lib/access/grants";

export type NasAct = "fan" | "backup";

export interface NasStanding {
    /** Connected it: everything, the place and lending included. */
    readonly manage: boolean;
    readonly fan: boolean;
    readonly backup: boolean;
    /** The grant each act a visitor makes spends; empty for the owner. */
    readonly grants: Partial<Record<NasAct, LiveGrant>>;
}

/** Pure: what a set of live grants allows. Null when none lets them watch. */
export function standingFromGrants(held: readonly LiveGrant[]): NasStanding | null {
    if (held.length === 0) return null;
    const allowing = (act: NasAct) =>
        held.find(
            (grant) =>
                core.atLeast("place.nas", grant.capability, "control") &&
                grant.actions.includes(act)
        );
    const fan = allowing("fan");
    const backup = allowing("backup");
    const watches = held.some((grant) => grant.actions.includes("watch")) || fan || backup;
    if (!watches) return null;
    return {
        manage: false,
        fan: Boolean(fan),
        backup: Boolean(backup),
        grants: { ...(fan ? { fan } : {}), ...(backup ? { backup } : {}) }
    };
}

/** What one account may do with one NAS, or null for nothing at all. */
export async function nasStanding(
    user: SessionUser,
    connectionId: string
): Promise<NasStanding | null> {
    const nas = await prisma.storageConnection.findFirst({
        where: { id: connectionId, kind: "unifi-unas" },
        select: { ownerId: true }
    });
    if (!nas) return null;
    if (nas.ownerId === user.id) return { manage: true, fan: true, backup: true, grants: {} };
    return standingFromGrants(await liveGrants(user.id, "place.nas", connectionId));
}
