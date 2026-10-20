/**
 * Who may look at, and who may drive, one UPS.
 *
 * Running UPSes is the platform's business (`system.manage`, the same gate as
 * the machines they shut down). But one can be lent, like a door in Places: to
 * watch - its status, history and events - or to control it as well - its
 * commands, writable variables and self-test. The same split NUT itself draws
 * between a read-only client and a user with instant-command rights.
 *
 * Lending never reaches the UPS's own settings: what it is connected to, which
 * machines it shuts down and when. Those stay with whoever runs the machines.
 */

import * as core from "@polaris/core";
import { sessionCan, type SessionUser } from "@/lib/session";
import { liveGrants, type LiveGrant } from "@/lib/access/grants";
import type { UpsView } from "@/lib/ups/ups-service";

export interface UpsStanding {
    /** Runs it: everything, settings included. */
    readonly manage: boolean;
    /** May send it commands, write its variables and test its battery. */
    readonly control: boolean;
    /** The grant a visitor's control spends, or null for an administrator or a
     *  visitor who only watches. */
    readonly grant: LiveGrant | null;
}

/** What one account may do with one UPS, or null for nothing at all. */
export async function upsStanding(user: SessionUser, upsId: string): Promise<UpsStanding | null> {
    if (await sessionCan(user, "system.manage"))
        return { manage: true, control: true, grant: null };
    const held = await liveGrants(user.id, "place.ups", upsId);
    if (held.length === 0) return null;
    const controlling = held.find(
        (grant) =>
            core.atLeast("place.ups", grant.capability, "control") &&
            grant.actions.includes("control")
    );
    if (controlling) return { manage: false, control: true, grant: controlling };
    return held.some((grant) => grant.actions.includes("watch"))
        ? { manage: false, control: false, grant: null }
        : null;
}

/**
 * A UPS as a visitor is shown it: what it is and how it is doing, without where
 * it is reached or which machines it shuts down - the settings they were not
 * lent, and addresses that are the house's business.
 */
export function visitorView(view: UpsView): UpsView {
    return {
        ...view,
        machineId: null,
        deviceId: null,
        host: null,
        username: null,
        hasSecret: false,
        shutdown: { ...view.shutdown, protectedMachineIds: [] }
    };
}
