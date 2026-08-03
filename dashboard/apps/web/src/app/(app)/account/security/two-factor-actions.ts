"use server";

/**
 * The second factor's own settings: the phone number a code can be sent to, and
 * which methods the account will accept.
 *
 * Every action re-resolves the session, so a user only ever changes their own.
 * The ones that widen the ways into the account - writing a number, turning a
 * method on - re-verify the password inside @polaris/auth, and the confirmation
 * code is throttled per account because six digits is a guessable secret.
 */

import { z } from "zod";
import { auth } from "@/lib/auth";
import { prisma } from "@polaris/db";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/session";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { newDeviceRefusal } from "@/lib/device-grace";
import { normalizePeerId } from "@/lib/messaging-service";
import { bridgeSend } from "@/lib/messaging/bridge-client";
import { describeTwoFactorMethods } from "@/lib/two-factor-delivery";
import {
    otpCodeField,
    phoneField,
    TWO_FACTOR_CODE_TTL_MINUTES,
    TWO_FACTOR_METHOD_INFO,
    twoFactorPreferencesSchema
} from "@polaris/core";
import {
    issuePhoneCode,
    regenerateBackupCodes,
    removeUserPhone,
    setTwoFactorPreferences,
    setUserPhone,
    verifyPhoneCode
} from "@polaris/auth";

type ActionResult = { error?: string };

/** How often one account may ask for a confirmation code, and how often it may
 *  guess at one. Both are per account rather than per address: the number is the
 *  thing being protected, and it does not change between attempts. */
const CODE_SEND_LIMIT = 5;
const CODE_SEND_WINDOW_MS = 15 * 60 * 1000;
const CODE_CHECK_LIMIT = 10;
const CODE_CHECK_WINDOW_MS = 15 * 60 * 1000;

const setPhoneSchema = z.object({
    phone: phoneField,
    password: z.string().min(1, "Password is required")
});

export async function setPhoneAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = setPhoneSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
    const result = await setUserPhone(auth, user.id, parsed.data.phone, parsed.data.password);
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.phone.set" });
        revalidatePath("/account/security");
    }
    return result;
}

export async function removePhoneAction(password: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const result = await removeUserPhone(auth, user.id, String(password ?? ""));
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.phone.removed" });
        revalidatePath("/account/security");
    }
    return result;
}

/**
 * Send a confirmation code to the number on the account.
 *
 * It goes through one of the user's own connected WhatsApp channels, which is
 * also the only way a second-factor code would ever reach that number - so
 * confirming the number and confirming the route are the same act, and a number
 * that confirms cannot later turn out to be unreachable.
 */
export async function sendPhoneCodeAction(): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const throttle = await rateLimit(`phone-code:${user.id}`, CODE_SEND_LIMIT, CODE_SEND_WINDOW_MS);
    if (!throttle.ok) {
        return { error: `Too many codes asked for. Try again in ${Math.ceil(throttle.retryAfterMs / 60000)} minutes.` };
    }

    const channel = await prisma.channel.findFirst({
        where: { ownerId: user.id, platform: "whatsapp", status: "connected" },
        orderBy: { createdAt: "asc" },
        select: { id: true }
    });
    if (!channel) return { error: "Connect one of your WhatsApp channels first - the code is sent through it." };

    const issued = await issuePhoneCode(auth, user.id);
    if (issued.error || !issued.code || !issued.phone) return { error: issued.error ?? "Add a phone number first." };

    try {
        await bridgeSend(channel.id, {
            peerId: normalizePeerId("whatsapp", issued.phone),
            text: `${issued.code} is your Polaris confirmation code. It expires in ${TWO_FACTOR_CODE_TTL_MINUTES} minutes.`
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : "The message could not be sent." };
    }
    await recordAudit({ actorId: user.id, action: "account.phone.code-sent" });
    return {};
}

export async function verifyPhoneAction(code: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = otpCodeField.safeParse(code);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Enter the 6-digit code." };
    const throttle = await rateLimit(`phone-check:${user.id}`, CODE_CHECK_LIMIT, CODE_CHECK_WINDOW_MS);
    if (!throttle.ok) {
        return { error: `Too many attempts. Try again in ${Math.ceil(throttle.retryAfterMs / 60000)} minutes.` };
    }
    const result = await verifyPhoneCode(auth, user.id, parsed.data);
    if (!result.error) {
        await recordAudit({ actorId: user.id, action: "account.phone.verified" });
        revalidatePath("/account/security");
    }
    return result;
}

/** How often one account may mint a set of backup codes. The endpoint checks a
 *  password, so it is a guessing surface as much as it is a control. */
const BACKUP_CODES_LIMIT = 5;
const BACKUP_CODES_WINDOW_MS = 15 * 60 * 1000;

const regenerateBackupCodesSchema = z.object({
    password: z.string().min(1, "Password is required")
});

/**
 * Mint a fresh set of backup codes and hand them back once.
 *
 * The only path by which a user gets codes after enrolment, and the only way to
 * replace a set that has been spent, printed and lost, or read over somebody's
 * shoulder. It invalidates whatever is left of the old set, which is the point:
 * the answer to "my printout is compromised" has to be one action, not turning
 * the authenticator off and on again.
 *
 * The codes are returned to the caller and nowhere else - the audit line records
 * that a set was issued and how many, never the codes themselves.
 */
export async function regenerateBackupCodesAction(
    input: unknown
): Promise<{ codes?: string[]; error?: string }> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = regenerateBackupCodesSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };
    const throttle = await rateLimit(`backup-codes:${user.id}`, BACKUP_CODES_LIMIT, BACKUP_CODES_WINDOW_MS);
    if (!throttle.ok) {
        return { error: `Too many attempts. Try again in ${Math.ceil(throttle.retryAfterMs / 60000)} minutes.` };
    }

    const result = await regenerateBackupCodes(auth, await headers(), parsed.data.password);
    if (result.codes) {
        await recordAudit({
            actorId: user.id,
            action: "account.2fa.backup-codes-issued",
            metadata: { count: result.codes.length }
        });
        revalidatePath("/account/security");
    }
    return result;
}

const savePreferencesSchema = z.object({
    preferences: twoFactorPreferencesSchema,
    password: z.string().min(1, "Password is required")
});

/**
 * Save which methods the account accepts and which one it offers first.
 *
 * A method may only be turned on when it could actually deliver right now:
 * accepting one that cannot is how an account ends up offering a way in that
 * silently sends nothing. The check is here rather than in @polaris/auth because
 * what can deliver is a fact about this deployment, not about the settings.
 */
export async function saveTwoFactorPreferencesAction(input: unknown): Promise<ActionResult> {
    const user = await requireUser();
    const blocked = await newDeviceRefusal(user);
    if (blocked) return { error: blocked };
    const parsed = savePreferencesSchema.safeParse(input);
    if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? "Check the form." };

    const statuses = await describeTwoFactorMethods(user.id);
    const unusable = parsed.data.preferences.methods.find(
        (method) => !statuses.find((status) => status.method === method)?.available
    );
    if (unusable) {
        return { error: `${TWO_FACTOR_METHOD_INFO[unusable].label} cannot send anything yet.` };
    }

    const result = await setTwoFactorPreferences(
        auth,
        user.id,
        parsed.data.preferences,
        parsed.data.password
    );
    if (!result.error) {
        await recordAudit({
            actorId: user.id,
            action: "account.2fa.methods-updated",
            metadata: {
                methods: parsed.data.preferences.methods,
                preferred: parsed.data.preferences.preferred
            }
        });
        revalidatePath("/account/security");
    }
    return result;
}
