/**
 * The gate every action that changes an account's protection passes through.
 *
 * Two questions, one call, because they have one answer and it is the same
 * sentence-shaped "no": is this account shut to changes at all, and is the
 * browser asking old enough on it to be allowed?
 *
 * An account can ask that a device newly seen on it wait before it may touch
 * anything under Security. The point is the hours after a password is taken:
 * whoever has it can sign in, and the first thing worth doing with a stolen
 * account is closing the doors the owner still has - the recovery address, the
 * questions, the sessions that would have noticed. Making the new device wait
 * leaves those doors open for as long as the owner asked for.
 *
 * Off unless the account turns it on, so this returns nothing for most accounts
 * and costs two indexed reads to say so.
 *
 * The lockdown half is the one the account raises itself when it thinks somebody
 * else is in it, and it is checked first because it is the stronger statement:
 * a device that has been here for years is refused by it exactly as a new one is.
 * The action that lifts a lockdown deliberately does not come through here -
 * a gate that refused its own way out would be a trap.
 *
 * Every refusal is the same sentence from @polaris/auth, because the same rule
 * refuses requests here and at the endpoints the browser calls directly, and two
 * wordings would read as two different rules.
 */

import { newDeviceWaitMessage, sessionDeviceStanding, type DeviceStanding } from "@polaris/auth";
import { lockedDown, LOCKDOWN_REFUSAL } from "@/lib/account-lifecycle";

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
    if (await lockedDown(caller.id)) return LOCKDOWN_REFUSAL;
    const standing = await sessionDeviceStanding(caller.id, caller.sessionId);
    return standing.settled ? null : newDeviceWaitMessage(standing);
}

/** The full standing, for the screen that explains the wait rather than
 *  enforcing it. */
export async function currentDeviceStanding(caller: Caller): Promise<DeviceStanding> {
    return sessionDeviceStanding(caller.id, caller.sessionId);
}
