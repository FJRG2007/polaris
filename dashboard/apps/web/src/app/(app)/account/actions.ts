"use server";

/**
 * Profile self-service actions. Each re-resolves the session, so a user can only
 * ever change their own profile or addresses. The credential work (verify, hash)
 * lives in @polaris/auth so there is one source of truth for how passwords are
 * stored; password and security settings live under ./security.
 */

import { z } from "zod";
import { auth } from "@/lib/auth";
import { emailField } from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { unlinkGithubIdentity } from "@/lib/github-identity";
import { requestEmailVerification } from "@/lib/email-verification-service";
import {
    addUserEmail,
    promoteUserEmail,
    removeUserEmail,
    setUserEmailRecovery,
    updateUserProfile
} from "@polaris/auth";

const emailIdSchema = z.string().uuid();

/** Verification links cost the provider's quota and land in someone's inbox, so
 *  asking for one is throttled per account. */
const VERIFY_LIMIT = 5;
const VERIFY_WINDOW_MS = 15 * 60 * 1000;

/**
 * Send a confirmation link to one of the user's own addresses. The service
 * checks the address really is theirs, so a forged id proves nothing.
 */
export async function verifyEmailAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = emailField.safeParse(input);
    if (!parsed.success) return { error: "Unknown address." };
    const throttle = await rateLimit(`email-verify:${user.id}`, VERIFY_LIMIT, VERIFY_WINDOW_MS);
    if (!throttle.ok) {
        return { error: `Too many requests. Try again in ${Math.ceil(throttle.retryAfterMs / 60000)} minutes.` };
    }
    const result = await requestEmailVerification(user.id, parsed.data);
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.email.verification-sent" });
    }
    return result;
}

export async function updateProfileAction(input: {
    name?: string;
    username?: string | null;
    company?: string | null;
}): Promise<{ error?: string }> {
    const user = await requireUser();
    const result = await updateUserProfile(user.id, {
        name: typeof input.name === "string" ? input.name : undefined,
        username: input.username === undefined ? undefined : (input.username ?? ""),
        company: input.company === undefined ? undefined : (input.company ?? "")
    });
    if (!result.error) revalidatePath("/account");
    return result;
}

export async function addEmailAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = emailField.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter a valid email" };
    const result = await addUserEmail(user.id, parsed.data);
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.email.added" });
        revalidatePath("/account");
    }
    return result;
}

export async function removeEmailAction(emailId: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = emailIdSchema.safeParse(emailId);
    if (!parsed.success) return { error: "That address is no longer on your account." };
    const result = await removeUserEmail(user.id, parsed.data);
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.email.removed" });
        revalidatePath("/account");
    }
    return result;
}

export async function setEmailRecoveryAction(emailId: unknown, recovery: boolean): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = emailIdSchema.safeParse(emailId);
    if (!parsed.success) return { error: "That address is no longer on your account." };
    const result = await setUserEmailRecovery(user.id, parsed.data, recovery === true);
    if (!result.error) {
        await recordAudit({
            actorId: user.id,
            action: recovery === true ? "account.email.recovery-set" : "account.email.recovery-cleared"
        });
        revalidatePath("/account");
    }
    return result;
}

export async function promoteEmailAction(emailId: unknown, currentPassword: string): Promise<{ error?: string }> {
    const user = await requireUser();
    const parsed = emailIdSchema.safeParse(emailId);
    if (!parsed.success) return { error: "That address is no longer on your account." };
    const result = await promoteUserEmail(auth, user.id, parsed.data, String(currentPassword));
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.email.primary-changed" });
        revalidatePath("/account");
    }
    return result;
}

/** Forget the GitHub account this profile is linked to. Self-service only: the
 *  session is re-resolved here, so this can never unlink somebody else. */
export async function unlinkGithubAction(): Promise<{ error?: string }> {
    const user = await requireUser();
    try {
        await unlinkGithubIdentity(user.id);
    } catch {
        return { error: "Could not unlink the GitHub account." };
    }
    revalidatePath("/account");
    return {};
}
