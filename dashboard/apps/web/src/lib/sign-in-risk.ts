/**
 * What makes a sign-in worth one more check, beside the unusual country the
 * second-factor policy already reads (Account > Security > "When to ask for
 * more"). Google's "Verify it's you" asks on the same kinds of signal: a device
 * the account has never used, and a place the account could not have reached
 * since its last sign-in.
 *
 * - New device: a browser the account's device register has never seen. An
 *   account whose register is empty predates it, and nothing reads as new
 *   there - every sign-in would otherwise be asked.
 * - Impossible travel: the last sign-in was on another continent less than
 *   `TRAVEL_WINDOW_MS` ago. Read by continent because the country is all a
 *   session keeps; two neighbouring countries an hour apart are an ordinary
 *   train ride.
 *
 * A datacenter address is not a signal here: Polaris has no classifier for it
 * without an optional reputation integration, and one that only some
 * deployments have would ask on some servers and not others.
 *
 * Never throws: a check that cannot be made is a sign-in that is not asked
 * for more, never one that is refused.
 */

import { prisma } from "@polaris/db";
import { continentOf } from "@polaris/core";

export type SignInRisk = "impossible-travel" | "new-device";

/** How recent another continent's sign-in has to be to make this one impossible. */
export const TRAVEL_WINDOW_MS = 3 * 60 * 60_000;

/** Pure: whether two sign-ins could not both be the same person travelling. */
export function impossibleTravel(
    previous: { country: string | null; at: Date } | null,
    country: string | null,
    now: Date
): boolean {
    if (!previous?.country || !country) return false;
    if (now.getTime() - previous.at.getTime() > TRAVEL_WINDOW_MS) return false;
    const before = continentOf(previous.country);
    const after = continentOf(country);
    return before !== null && after !== null && before !== after;
}

export async function signInRisk(input: {
    userId: string;
    sessionId: string;
    country: string | null;
    userAgent: string | null;
}): Promise<SignInRisk | null> {
    try {
        const previous = await prisma.sessionState.findFirst({
            where: { userId: input.userId, sessionId: { not: input.sessionId }, country: { not: null } },
            orderBy: { createdAt: "desc" },
            select: { country: true, createdAt: true }
        });
        if (impossibleTravel(previous && { country: previous.country, at: previous.createdAt }, input.country, new Date()))
            return "impossible-travel";
        if (!input.userAgent) return null;
        const [known, any] = await Promise.all([
            prisma.accountDevice.count({ where: { userId: input.userId, userAgent: input.userAgent.slice(0, 512) } }),
            prisma.accountDevice.count({ where: { userId: input.userId } })
        ]);
        return any > 0 && known === 0 ? "new-device" : null;
    } catch (error) {
        console.error("polaris: sign-in risk not read:", error);
        return null;
    }
}
