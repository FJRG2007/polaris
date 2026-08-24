/**
 * A proof this session gave a moment ago, so a screen full of switches asks for
 * one once instead of once per switch.
 *
 * The problem it solves is not convenience for its own sake. A gate that asks
 * for a code every time somebody flips a toggle is a gate people turn off, or
 * work around by leaving the dangerous setting the way it already was - and a
 * confirmation dialog that appears six times in a row stops being read by the
 * third. Asking once and meaning it for two minutes is a stronger gate in
 * practice than asking six times.
 *
 * Three things keep it honest, and none of them is optional:
 *
 * **Scoped to one session.** A proof given on a laptop is not a proof given on
 * the phone in somebody else's hand. The grant names the session id, and a
 * different session finds nothing.
 *
 * **Scoped to one purpose.** A proof given to change how sign-in works is not
 * permission to name an account successor. There is no wildcard purpose and
 * there is deliberately no way to write one.
 *
 * **Spent by the clock, not by use.** Two minutes from the moment it was proved,
 * and flipping four switches inside them costs one proof. It is not extended by
 * using it: a window that renewed itself on every use would be an open door for
 * as long as somebody kept the tab busy.
 *
 * A row past its moment is ignored on read and removed on the next write, so
 * nothing has to be running for the window to close.
 */

import { prisma } from "@polaris/db";

/**
 * How long a proof stands.
 *
 * Two minutes. Long enough to change your mind about three switches, short
 * enough that a screen left open on a desk is not a standing permission.
 */
export const STEP_UP_GRANT_MS = 2 * 60 * 1000;

/** What a grant may be given for. A closed list, because the whole value of the
 *  scoping is that nothing can invent a purpose that covers everything. */
export const STEP_UP_PURPOSES = ["connected-sign-in", "lockdown", "close-account"] as const;

export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];

/**
 * Record that this session proved itself for this purpose.
 *
 * Called only after a proof was actually checked. It is an upsert rather than an
 * insert: proving again inside the window restarts it, which is what somebody
 * who has just typed a code expects.
 */
export async function grantStepUp(
    userId: string,
    sessionId: string,
    purpose: StepUpPurpose
): Promise<void> {
    const expiresAt = new Date(Date.now() + STEP_UP_GRANT_MS);
    await prisma.stepUpGrant.upsert({
        where: { sessionId_purpose: { sessionId, purpose } },
        create: { userId, sessionId, purpose, expiresAt },
        update: { userId, expiresAt }
    });
}

/**
 * Whether this session has already proved itself for this purpose, and still
 * has time left on it.
 *
 * The user id is checked as well as the session id. They should never disagree -
 * a session belongs to one account - but the row outlives nothing else here, and
 * a lookup that trusted the session alone would be one rotation away from being
 * wrong.
 */
export async function stepUpGranted(
    userId: string,
    sessionId: string,
    purpose: StepUpPurpose
): Promise<boolean> {
    const row = await prisma.stepUpGrant.findUnique({
        where: { sessionId_purpose: { sessionId, purpose } },
        select: { userId: true, expiresAt: true }
    });
    return row !== null && row.userId === userId && row.expiresAt.getTime() > Date.now();
}

/** How long is left on it, in seconds, for the screen that counts it down. Zero
 *  when there is nothing to count. */
export async function stepUpRemainingMs(
    userId: string,
    sessionId: string,
    purpose: StepUpPurpose
): Promise<number> {
    const row = await prisma.stepUpGrant.findUnique({
        where: { sessionId_purpose: { sessionId, purpose } },
        select: { userId: true, expiresAt: true }
    });
    if (!row || row.userId !== userId) return 0;
    return Math.max(0, row.expiresAt.getTime() - Date.now());
}

/**
 * Drop every grant this account holds.
 *
 * Called where the account's standing changes underneath them - a password
 * changed, a lockdown raised. A proof given before that moment was a proof about
 * a different situation.
 */
export async function revokeStepUpGrants(userId: string): Promise<void> {
    await prisma.stepUpGrant.deleteMany({ where: { userId } });
}

/** Remove what has run out. Cheap, unindexed by nothing, and called from the
 *  housekeeping sweep rather than on the path of a request. */
export async function pruneStepUpGrants(): Promise<number> {
    const removed = await prisma.stepUpGrant.deleteMany({
        where: { expiresAt: { lt: new Date() } }
    });
    return removed.count;
}
