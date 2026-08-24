/**
 * The three things an account can do to itself: shut down, switch off, or go.
 *
 * They look like one feature and are three different promises.
 *
 * **Lockdown** is the emergency. The owner believes somebody else is in the
 * account. It shuts every door that could change how the account is protected,
 * refuses every new sign-in, and leaves the sessions already open alone - because
 * an owner locked out of the screen they need is an owner who cannot lift it
 * again. An administrator is told and the account goes on the safety queue. It is
 * the one setting whose meaning is "something has gone wrong here".
 *
 * **Disabled** is the quiet one. The account goes away and comes back by signing
 * in, which is the whole of the design: no ticket, no support request, no wait.
 *
 * **Deletion** is the same shape with a longer wait and an ending. Nothing is
 * removed until the wait is up and signing in before then calls it off, because
 * the account somebody deletes in anger on a Friday is the account they want back
 * on Monday.
 *
 * What actually removes an account when the wait is up is deliberately not here:
 * that is a sweep, it runs on a schedule, and it is the one operation in this
 * file that cannot be undone by anybody.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { recordAudit } from "@/lib/audit-service";
import { openLockdownCase } from "@/lib/safety-queue";
import { notify } from "@/lib/notifications/dispatch";
import { revokeStepUpGrants } from "@/lib/step-up-grant";

/** Where the account itself reads about any of this. */
const SECURITY_HREF = "/account/security";

/** What an account is currently doing to itself, for the screens that draw it. */
export interface AccountStanding {
    readonly lockedDown: boolean;
    readonly lockdownSince: string | null;
    readonly lockdownNote: string;
    readonly closure: core.AccountClosure | null;
    /** Days left of the deletion wait, for the banner that says so. */
    readonly daysLeft: number;
}

export async function accountLifecycle(userId: string): Promise<AccountStanding> {
    const [user, security] = await Promise.all([
        prisma.user.findUnique({
            where: { id: userId },
            select: { disabledAt: true, deletionRequestedAt: true }
        }),
        prisma.userSecurity.findUnique({
            where: { userId },
            select: { lockdownAt: true, lockdownNote: true }
        })
    ]);

    // Deletion wins the label when both are set. It is the one with an ending.
    const closure: core.AccountClosure | null = user?.deletionRequestedAt
        ? "deleting"
        : user?.disabledAt
          ? "disabled"
          : null;

    return {
        lockedDown: security?.lockdownAt != null,
        lockdownSince: security?.lockdownAt?.toISOString() ?? null,
        lockdownNote: security?.lockdownNote ?? "",
        closure,
        daysLeft: user?.deletionRequestedAt
            ? core.daysLeft(user.deletionRequestedAt, new Date())
            : 0
    };
}

/** Whether this account is shut to everything that could change it. Read on
 *  every security action, so it is one indexed row and nothing else. */
export async function lockedDown(userId: string): Promise<boolean> {
    const row = await prisma.userSecurity.findUnique({
        where: { userId },
        select: { lockdownAt: true }
    });
    return row?.lockdownAt != null;
}

/** What a refused security action says. One sentence, and it names the way out -
 *  a refusal that does not is a dead end. */
export const LOCKDOWN_REFUSAL =
    "Your account is locked down. Lift it under Security before changing anything else.";

/**
 * Shut the account down.
 *
 * The proof was checked by the caller: this is not the place that decides who is
 * allowed, it is the place that does it. Every step-up grant is dropped with it -
 * a proof given a minute ago was a proof about a situation that has just changed.
 */
export async function raiseLockdown(userId: string, note: string): Promise<void> {
    await prisma.userSecurity.upsert({
        where: { userId },
        create: { userId, lockdownAt: new Date(), lockdownNote: note },
        update: { lockdownAt: new Date(), lockdownNote: note }
    });
    await revokeStepUpGrants(userId);
    await recordAudit({ actorId: userId, action: "account.lockdown.raised" });
    await openLockdownCase(userId, note);
    await notify({
        userId,
        event: "account.security",
        title: "Your account is locked down",
        body: "Nothing about how it is protected can be changed and no new sign-in works. The devices already signed in keep working, and an administrator has been told.",
        href: SECURITY_HREF,
        actionRequired: true
    }).catch(() => undefined);
}

/**
 * Lift it.
 *
 * The case on the queue is deliberately left open: an administrator settles it
 * when they have looked, and an owner lifting their own lockdown is not the same
 * event as somebody having checked that the account is all right.
 */
export async function liftLockdown(userId: string): Promise<void> {
    await prisma.userSecurity.updateMany({
        where: { userId },
        data: { lockdownAt: null, lockdownNote: null }
    });
    await recordAudit({ actorId: userId, action: "account.lockdown.lifted" });
}

/**
 * Switch the account off, or ask for it to be deleted.
 *
 * Both end every session, which is what makes them real: an account that is off
 * but still open on four devices is off in name only. The session doing the
 * asking goes with the rest - the browser is about to be signed out anyway, and
 * leaving one behind would be leaving the one that could undo it.
 */
export async function closeAccount(
    userId: string,
    closure: core.AccountClosure
): Promise<void> {
    const now = new Date();
    await prisma.user.update({
        where: { id: userId },
        data:
            closure === "deleting"
                ? { deletionRequestedAt: now, disabledAt: now }
                : { disabledAt: now }
    });
    await prisma.session.deleteMany({ where: { userId } });
    await revokeStepUpGrants(userId);
    await recordAudit({
        actorId: userId,
        action: closure === "deleting" ? "account.deletion.requested" : "account.disabled"
    });
    await notify({
        userId,
        event: "account.security",
        title:
            closure === "deleting"
                ? "Your account will be deleted"
                : "Your account has been switched off",
        body:
            closure === "deleting"
                ? `Nothing is removed for ${core.DELETION_GRACE_DAYS} days. Sign in before then and it is called off - there is nothing else to do and nobody to ask.`
                : "Sign in again whenever you like and it comes straight back.",
        href: SECURITY_HREF
    }).catch(() => undefined);
}

/**
 * Bring it back, because somebody signed in.
 *
 * The only way back, and deliberately the easy one. Clears the account's own two
 * columns and nothing else - a suspension the instance imposed is not the
 * owner's to lift, and an account holding both comes back to being suspended.
 *
 * Returns what it undid, so the caller can say so on screen.
 */
export async function restoreAccount(userId: string): Promise<core.AccountClosure | null> {
    const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { disabledAt: true, deletionRequestedAt: true }
    });
    if (!user?.disabledAt && !user?.deletionRequestedAt) return null;

    const undone: core.AccountClosure = user.deletionRequestedAt ? "deleting" : "disabled";
    await prisma.user.update({
        where: { id: userId },
        data: { disabledAt: null, deletionRequestedAt: null }
    });
    await recordAudit({
        actorId: userId,
        action: undone === "deleting" ? "account.deletion.cancelled" : "account.enabled"
    });
    await notify({
        userId,
        event: "account.security",
        title:
            undone === "deleting"
                ? "Your account will not be deleted"
                : "Your account is back",
        body: "Signing in brought it back. Nothing was lost.",
        href: SECURITY_HREF
    }).catch(() => undefined);
    return undone;
}
