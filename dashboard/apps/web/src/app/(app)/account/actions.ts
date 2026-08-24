"use server";

/**
 * Profile self-service actions. Each re-resolves the session, so a user can only
 * ever change their own profile or addresses. The credential work (verify, hash)
 * lives in @polaris/auth so there is one source of truth for how passwords are
 * stored; password and security settings live under ./security.
 *
 * The addresses, the username and the linked GitHub account are identity rather
 * than presentation - they are what a password reset is sent to and what the
 * account is known by - so each passes the new-device gate when the account has
 * asked for one. A display name or a company is left alone by it: those change
 * nothing about who can get in.
 */

import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@polaris/db";
import { emailField, USERNAME_COOLDOWN_KEY, usernameCooldownDays } from "@polaris/core";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { getSetting } from "@/lib/setting-store";
import { rateLimit } from "@/lib/rate-limit-service";
import { newDeviceRefusal } from "@/lib/device-grace";
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

/**
 * Whether a profile save would actually take a different username.
 *
 * The form sends every field on every save, so gating on "a username was sent"
 * would stop a new device fixing its display name for a week over a value it did
 * not touch. Compared the way a username is matched - trimmed and caseless -
 * since retyping the same name in different capitals is not a change.
 */
async function changesUsername(userId: string, username: string | null | undefined): Promise<boolean> {
    if (username === undefined) return false;
    const row = await prisma.user.findUnique({ where: { id: userId }, select: { username: true } });
    return (username ?? "").trim().toLowerCase() !== (row?.username ?? "").trim().toLowerCase();
}

export async function updateProfileAction(input: {
    name?: string;
    firstName?: string | null;
    lastName?: string | null;
    username?: string | null;
    company?: string | null;
    description?: string | null;
}): Promise<{ error?: string }> {
    const user = await requireUser();
    if (await changesUsername(user.id, input.username)) {
        const blocked = await newDeviceRefusal(user);
        if (blocked) return { error: blocked };
    }
    const result = await updateUserProfile(
        user.id,
        {
            name: typeof input.name === "string" ? input.name : undefined,
            firstName: input.firstName === undefined ? undefined : (input.firstName ?? ""),
            lastName: input.lastName === undefined ? undefined : (input.lastName ?? ""),
            username: input.username === undefined ? undefined : (input.username ?? ""),
            company: input.company === undefined ? undefined : (input.company ?? ""),
            description: input.description === undefined ? undefined : (input.description ?? "")
        },
        // The operator's wait between handle changes. Read here because the
        // setting store is the dashboard's, and the auth package deliberately
        // does not reach into it.
        { cooldownDays: usernameCooldownDays(await getSetting(USERNAME_COOLDOWN_KEY)) }
    );
    if (!result.error) revalidatePath("/account");
    return result;
}

export async function addEmailAction(input: unknown): Promise<{ error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
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
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
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
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
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
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = emailIdSchema.safeParse(emailId);
    if (!parsed.success) return { error: "That address is no longer on your account." };
    const result = await promoteUserEmail(auth, user.id, parsed.data, String(currentPassword));
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.email.primary-changed" });
        revalidatePath("/account");
    }
    return result;
}
