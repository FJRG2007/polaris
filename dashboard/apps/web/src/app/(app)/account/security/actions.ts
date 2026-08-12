"use server";

/**
 * Account-security actions. Every one re-resolves the session, so a user can only
 * ever change their own protection, and every input is re-validated against the
 * shared schemas - the dialogs validate the same shapes, but the client is not
 * the enforcement point.
 *
 * Actions that weaken a control (setting a PIN, replacing the recovery questions,
 * changing the password) re-verify the current password inside @polaris/auth, so
 * a stolen session cannot quietly install its own way back in.
 *
 * Every one of them also passes the new-device gate first, when the account has
 * asked for one. The password is not proof of much in the hours after it has been
 * taken, which is exactly when these actions are worth the most to somebody who
 * should not have it.
 */

import { z } from "zod";
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { clientIp } from "@/lib/request-context";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { newDeviceRefusal } from "@/lib/device-grace";
import { setConnectionSignIn } from "@/lib/connections/store";
import { revokeOtherSessions, sessionSignInRecord } from "@/lib/session-directory";
import {
    newDeviceGraceSchema,
    recoverPasswordSchema,
    securityQuestionsSchema,
    sessionLimitsSchema,
    setPinSchema
} from "@polaris/core";
import {
    beginSessionRotation,
    carrySignInRecord,
    changeUserPassword,
    setNewDeviceGrace,
    setConnectionSignInChallenge,
    clearQuickPin,
    clearSecurityQuestions,
    getUserSecurity,
    resetUserPassword,
    setLoginApprovalRequired,
    setQuickPin,
    setSecurityQuestions,
    updateSessionLimits,
    verifyAccountPassword,
    verifySecurityAnswers,
    verifyTotpForSession,
    twoFactorEnabled
} from "@polaris/auth";

type ActionResult = { error?: string };

/**
 * Allow, or stop allowing, one connected account as a way into this Polaris.
 *
 * A way in, so it is gated like the rest of this page: a browser the account has
 * only just met waits it out first. Turning it off never unlinks anything - what
 * the account was connected for goes on working - and turning it on is worth
 * nothing on its own unless the operator allows that service too.
 */
export async function setConnectionSignInAction(connectionId: string, enabled: boolean): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };

    const parsed = z.string().uuid().safeParse(connectionId);
    if (!parsed.success) return { error: "That account is no longer connected." };

    const updated = await setConnectionSignIn(user.id, parsed.data, enabled === true);
    if (!updated) return { error: "That account is no longer connected." };
    revalidatePath("/account/security");
    return {};
}

/**
 * Ask for the second-factor challenge after a connected account signs this
 * person in, or stop asking.
 *
 * Gated like the rest of the page, because turning it off takes a step away. The
 * instance's own demand is read separately and is not touched here, so an
 * operator who asks for it everywhere goes on getting it whatever this says.
 */
export async function setConnectionSignInChallengeAction(challenge: boolean): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };

    await setConnectionSignInChallenge(user.id, challenge === true);
    await recordAudit({
        actorId: user.id,
        action: "account.connection-sign-in.challenge",
        metadata: { challenge: challenge === true }
    });
    revalidatePath("/account/security");
    return {};
}

/** Guess-throttling for the identity proofs that stand in for the password. */
const RECOVERY_LIMIT = 5;
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;

export async function changePasswordAction(currentPassword: string, newPassword: string): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const result = await changeUserPassword(auth, user.id, String(currentPassword), String(newPassword));
    if (!result.error) {
        await revokeOtherSessions(user.id, user.sessionId);
        await recordAudit({ actorId: user.id, action: "account.password.changed" });
    }
    return result;
}

/**
 * Set a new password without the old one, for a user who has forgotten it while
 * still signed in. Identity is proven by the recovery questions or by a valid
 * authenticator code; both are throttled, because both are guessable in a way a
 * password is not. Succeeding also ends every other session.
 */
export async function recoverPasswordAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = recoverPasswordSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

    const throttle = await rateLimit(`account-recovery:${user.id}`, RECOVERY_LIMIT, RECOVERY_WINDOW_MS);
    if (!throttle.ok) {
        return { error: `Too many attempts. Try again in ${Math.ceil(throttle.retryAfterMs / 60000)} minutes.` };
    }

    const proven = parsed.data.totpCode
        ? (await twoFactorEnabled(user.id)) &&
          (await verifyTotpForSession(auth, await headers(), parsed.data.totpCode))
        : await verifySecurityAnswers(auth, user.id, parsed.data.answers);
    if (!proven) {
        await recordAudit({ actorId: user.id, action: "account.password.recovery-failed" });
        return { error: "We could not verify that. Check your answers or code and try again." };
    }

    const result = await resetUserPassword(auth, user.id, parsed.data.newPassword);
    if (!result.error) {
        await revokeOtherSessions(user.id, user.sessionId);
        await recordAudit({ actorId: user.id, action: "account.password.recovered" });
    }
    return result;
}

/**
 * Announce that this session is about to be replaced, so its replacement is not
 * mistaken for a new sign-in and held for approval.
 *
 * Arming or removing an authenticator ends the session it was done from and
 * issues a fresh one; without this the user was sent to the approval screen and
 * told to allow it from another session, which is exactly the session that had
 * just been ended. Called by the authenticator dialogs immediately before the
 * step that replaces the session.
 *
 * The replacement inherits how this session signed in, for the same reason: it is
 * the same sign-in continuing, and a session list that suddenly could not say how
 * the reader's own device got in would be reporting the rotation as a mystery.
 */
export async function beginSessionRotationAction(): Promise<void> {
    const user = await requireUser();
    await beginSessionRotation(user.id, (await clientIp()) ?? null);
    await carrySignInRecord(user.id, await sessionSignInRecord(user.id, user.sessionId));
}

export async function setPinAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = setPinSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
    const result = await setQuickPin(auth, user.id, parsed.data.pin, parsed.data.password);
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.pin.set" });
        revalidatePath("/account/security");
    }
    return result;
}

export async function clearPinAction(password: string): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    // Approving a sign-in is what the PIN proves, so it cannot outlive the PIN.
    const security = await getUserSecurity(user.id);
    if (security.requireLoginApproval) {
        return { error: "Turn off approving sign-ins from an open session first - it asks for this PIN." };
    }
    const result = await clearQuickPin(auth, user.id, String(password));
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.pin.cleared" });
        revalidatePath("/account/security");
    }
    return result;
}

/**
 * Set how long a device newly seen on this account waits before it may change
 * anything here.
 *
 * Gated like everything else on the page, which is what stops the wait being the
 * first thing a device inside one turns off. Raising it, lowering it and turning
 * it off are all the same decision and all need a device the account already
 * knows.
 */
export async function setNewDeviceGraceAction(days: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = newDeviceGraceSchema.safeParse(days);
    if (!parsed.success) return { error: "Pick one of the offered waits." };
    await setNewDeviceGrace(user.id, parsed.data);
    await recordAudit({
        actorId: user.id,
        action: "account.new-device-grace.updated",
        metadata: { days: parsed.data }
    });
    revalidatePath("/account/security");
    return {};
}

export async function updateSessionLimitsAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = sessionLimitsSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
    await updateSessionLimits(user.id, parsed.data);
    await recordAudit({ actorId: user.id, action: "account.session-limits.updated", metadata: parsed.data });
    revalidatePath("/account/security");
    return {};
}

/**
 * Turn the sign-in approval gate on or off. Allowing a waiting sign-in asks for
 * the quick-unlock PIN, so the gate cannot be armed without one: otherwise the
 * approval would rest on nothing more than the open session it is decided from.
 *
 * It is also the alternative to a second factor rather than an addition to it: an
 * account that answers a code at sign-in is not held for approval as well, so
 * arming the gate while the authenticator is on is refused instead of quietly
 * storing a setting that would never be used.
 *
 * Taking the gate down widens the ways in, so it is verified the same way the
 * other second-factor settings are - a stolen session cannot quietly disarm it.
 */
export async function setLoginApprovalAction(required: boolean, password: string): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    if (!(await verifyAccountPassword(auth, user.id, String(password)))) {
        return { error: "Current password is incorrect." };
    }
    if (required === true && (await twoFactorEnabled(user.id))) {
        return { error: "Turn the authenticator app off first - a sign-in asks for one of the two, not both." };
    }
    if (required === true && !(await getUserSecurity(user.id)).hasPin) {
        return { error: "Set a quick unlock PIN first - approving a sign-in asks for it." };
    }
    await setLoginApprovalRequired(user.id, required === true);
    await recordAudit({
        actorId: user.id,
        action: required ? "account.login-approval.enabled" : "account.login-approval.disabled"
    });
    revalidatePath("/account/security");
    return {};
}

export async function setSecurityQuestionsAction(password: string, input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = securityQuestionsSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
    const result = await setSecurityQuestions(auth, user.id, String(password), parsed.data.answers);
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.security-questions.set" });
        revalidatePath("/account/security");
    }
    return result;
}

export async function clearSecurityQuestionsAction(password: string): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const result = await clearSecurityQuestions(auth, user.id, String(password));
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.security-questions.cleared" });
        revalidatePath("/account/security");
    }
    return result;
}
