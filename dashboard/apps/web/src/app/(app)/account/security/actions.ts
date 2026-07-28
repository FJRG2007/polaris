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
 */

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import {
    changeUserPassword,
    clearQuickPin,
    clearSecurityQuestions,
    resetUserPassword,
    setLoginApprovalRequired,
    setQuickPin,
    setSecurityQuestions,
    updateSessionLimits,
    verifySecurityAnswers,
    verifyTotpForSession,
    twoFactorEnabled
} from "@polaris/auth";
import { recoverPasswordSchema, securityQuestionsSchema, sessionLimitsSchema, setPinSchema } from "@polaris/core";
import { auth } from "@/lib/auth";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { requireUser } from "@/lib/session";
import { revokeOtherSessions } from "@/lib/session-directory";

type ActionResult = { error?: string };

/** Guess-throttling for the identity proofs that stand in for the password. */
const RECOVERY_LIMIT = 5;
const RECOVERY_WINDOW_MS = 15 * 60 * 1000;

export async function changePasswordAction(currentPassword: string, newPassword: string): Promise<ActionResult> {
    const user = await requireUser();
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

export async function setPinAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
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
    const result = await clearQuickPin(auth, user.id, String(password));
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.pin.cleared" });
        revalidatePath("/account/security");
    }
    return result;
}

export async function updateSessionLimitsAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const parsed = sessionLimitsSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
    await updateSessionLimits(user.id, parsed.data);
    await recordAudit({ actorId: user.id, action: "account.session-limits.updated", metadata: parsed.data });
    revalidatePath("/account/security");
    return {};
}

export async function setLoginApprovalAction(required: boolean): Promise<ActionResult> {
    const user = await requireUser();
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
    const result = await clearSecurityQuestions(auth, user.id, String(password));
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.security-questions.cleared" });
        revalidatePath("/account/security");
    }
    return result;
}
