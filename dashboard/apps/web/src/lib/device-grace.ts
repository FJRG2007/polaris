/**
 * The gate every action that changes an account's protection passes through: is
 * the browser asking for it old enough on this account to be allowed to?
 *
 * An account can ask that a device newly seen on it wait before it may touch
 * anything under Security. The point is the hours after a password is taken:
 * whoever has it can sign in, and the first thing worth doing with a stolen
 * account is closing the doors the owner still has - the recovery address, the
 * questions, the sessions that would have noticed. Making the new device wait
 * leaves those doors open for as long as the owner asked for.
 *
 * Off unless the account turns it on, so this returns nothing for most accounts
 * and costs one indexed read to say so.
 *
 * Every refusal is the same sentence from @polaris/auth, because the same rule
 * refuses requests here and at the endpoints the browser calls directly, and two
 * wordings would read as two different rules.
 */

import { newDeviceWaitMessage, sessionDeviceStanding, type DeviceStanding } from "@polaris/auth";

/** The caller, as every server action already has it in hand. */
interface Caller {
    id: string;
    sessionId: string;
}

/**
 * Why this device may not change the account's protection, or null when it may.
 *
 * Meant to be the first thing an action does after resolving its user:
 *
 *     const blocked = await newDeviceRefusal(user);
 *     if (blocked) return { error: blocked };
 */
export async function newDeviceRefusal(caller: Caller): Promise<string | null> {
    const standing = await sessionDeviceStanding(caller.id, caller.sessionId);
    return standing.settled ? null : newDeviceWaitMessage(standing);
}

/** The full standing, for the screen that explains the wait rather than
 *  enforcing it. */
export async function currentDeviceStanding(caller: Caller): Promise<DeviceStanding> {
    return sessionDeviceStanding(caller.id, caller.sessionId);
}
