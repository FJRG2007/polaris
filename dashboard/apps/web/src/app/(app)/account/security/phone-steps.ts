/**
 * Adding, confirming, choosing the primary of and removing the phone numbers on
 * an account, for a caller that has already been resolved.
 *
 * Two screens do this: Account > Details, behind the session guard, and the
 * enrollment step an instance that requires a phone sends people to, which the
 * guard is holding. Each resolves its own caller and decides whether the
 * new-device wait applies; everything after that is here, once, so the two
 * cannot drift apart.
 *
 * Server-only, and deliberately not a "use server" module: every function takes
 * the caller as an argument, which must never be something a browser can supply.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { auth } from "@/lib/auth";
import { revalidatePath } from "next/cache";
import { recordAudit } from "@/lib/audit-service";
import { rateLimit } from "@/lib/rate-limit-service";
import { getTranslations } from "@/lib/i18n/request";
import { firstIssue, localized } from "./action-messages";
import { normalizePeerId } from "@/lib/messaging-service";
import { phoneCodeRoute } from "@/lib/messaging/code-senders";
import { sendSmsThroughChannel } from "@/lib/notifications/sms-service";
import { sendCodeThroughChannel } from "@/lib/messaging/channel-runtime";
import { getInstanceSecurity } from "@/lib/instance-security";
import { challengeOptions } from "@/lib/two-factor-delivery";
import { phoneCanApprove } from "@/lib/mobile/sign-in-approval";
import { notifyPhoneClaimed } from "@/lib/notifications/security-events";
import { maskPhone, otpCodeField, phoneField, TWO_FACTOR_CODE_TTL_MINUTES } from "@polaris/core";
import {
    addUserPhone,
    issuePhoneCode,
    promoteUserPhone,
    removeUserPhone,
    twoFactorEnabled,
    verifyPhoneCode
} from "@polaris/auth";

type ActionResult = { error?: string };

/** Which number on the account. Absent means the primary, which is what a
 *  caller from before an account could hold several numbers meant. */
const phoneIdField = z.string().uuid().optional();

/** How often one account may ask for a confirmation code, and how often it may
 *  guess at one. Both are per account rather than per address: the number is the
 *  thing being protected, and it does not change between attempts. */
export const CODE_SEND_LIMIT = 5;
export const CODE_SEND_WINDOW_MS = 15 * 60 * 1000;
export const CODE_CHECK_LIMIT = 10;
export const CODE_CHECK_WINDOW_MS = 15 * 60 * 1000;
/** How many confirmation codes one number may be sent across every account, so
 *  a number nobody here holds cannot be flooded by accounts taking turns. */
export const NUMBER_SEND_LIMIT = 5;

const addPhoneSchema = z.object({
    phone: phoneField,
    password: z.string().min(1, "Password is required")
});

const removePhoneSchema = z.object({
    id: phoneIdField,
    password: z.string().min(1, "Password is required")
});

const verifyPhoneSchema = z.object({ id: phoneIdField, code: otpCodeField });

/** Whether the instance requires a confirmed number of this account, which keeps
 *  its last confirmed one from being removed. Administrators are exempt, as they
 *  are from the requirement itself. */
async function phoneEnforced(userId: string): Promise<boolean> {
    if (!(await getInstanceSecurity()).requirePhone) return false;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    return user?.isAdmin !== true;
}

/** Add a number. The id comes back so the screen can confirm that one. */
export async function addPhoneFor(userId: string, input: unknown): Promise<ActionResult & { id?: string }> {
    const parsed = addPhoneSchema.safeParse(input);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.checkForm");
    const result = await addUserPhone(auth, userId, parsed.data.phone, parsed.data.password);
    if (result.error) return localized({ error: result.error });
    await recordAudit({ actorId: userId, action: "account.phone.set" });
    revalidatePath("/account/security", "layout");
    return { id: result.id };
}

/**
 * Remove a number. Takes `{ id, password }`; a bare password is the shape a page
 * loaded before several numbers existed sends, and removes the primary.
 */
export async function removePhoneFor(userId: string, input: unknown): Promise<ActionResult> {
    const parsed = removePhoneSchema.safeParse(typeof input === "string" ? { password: input } : input);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.checkForm");
    const result = await removeUserPhone(auth, userId, parsed.data.password, {
        phoneId: parsed.data.id,
        keepOneConfirmed: await phoneEnforced(userId)
    });
    if (!result.error) {
        await recordAudit({ actorId: userId, action: "account.phone.removed" });
        revalidatePath("/account/security", "layout");
    }
    return localized(result);
}

/** Make a confirmed number the one codes are sent to. */
export async function makePhonePrimaryFor(userId: string, id: unknown): Promise<ActionResult> {
    const parsed = z.string().uuid().safeParse(id);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.checkForm");
    const result = await promoteUserPhone(userId, parsed.data);
    if (!result.error) {
        await recordAudit({ actorId: userId, action: "account.phone.primary-changed" });
        revalidatePath("/account/security", "layout");
    }
    return localized(result);
}

/**
 * Send a confirmation code to a number on the account (the primary when no id is
 * given).
 *
 * It goes the way a second-factor code would - the deployment's WhatsApp code
 * sender, or the user's own connected channel on an older setup, else the SMS
 * code sender - so confirming the number and confirming the route are the same act.
 *
 * A number another account has confirmed gets its code like any other: whoever
 * holds the phone is who may have it (see verifyPhoneCode).
 */
export async function sendPhoneCodeFor(userId: string, id?: unknown): Promise<ActionResult> {
    const phoneId = phoneIdField.safeParse(id ?? undefined);
    if (!phoneId.success) return firstIssue(phoneId.error.issues, "errors.checkForm");
    const t = await getTranslations("accountSecurity");
    const throttle = await rateLimit(`phone-code:${userId}`, CODE_SEND_LIMIT, CODE_SEND_WINDOW_MS);
    if (!throttle.ok) {
        return { error: t("errors.tooManyCodes", { minutes: Math.ceil(throttle.retryAfterMs / 60000) }) };
    }

    const route = await phoneCodeRoute(userId);
    if (!route) return { error: t("errors.connectWhatsAppFirst") };

    const issued = await issuePhoneCode(auth, userId, phoneId.data);
    if (issued.error || !issued.code || !issued.phone) {
        return issued.error ? localized({ error: issued.error }) : { error: t("known.addPhoneFirst") };
    }
    const perNumber = await rateLimit(`phone-code-number:${issued.phone}`, NUMBER_SEND_LIMIT, CODE_SEND_WINDOW_MS);
    if (!perNumber.ok) {
        return { error: t("errors.tooManyCodes", { minutes: Math.ceil(perNumber.retryAfterMs / 60000) }) };
    }

    // Sent to this same person, so in the language they are reading in.
    const text = t("phone.confirmationMessage", { code: issued.code, minutes: TWO_FACTOR_CODE_TTL_MINUTES });
    if (route.platform === "sms") {
        const sent = await sendSmsThroughChannel(route.channelId, issued.phone, text);
        if (sent.error) return { error: sent.error };
        await recordAudit({ actorId: userId, action: "account.phone.code-sent" });
        return {};
    }
    try {
        await sendCodeThroughChannel(route.channelId, {
            peerId: normalizePeerId("whatsapp", issued.phone),
            code: issued.code,
            text
        });
    } catch (caught) {
        return { error: caught instanceof Error ? caught.message : t("errors.messageNotSent") };
    }
    await recordAudit({ actorId: userId, action: "account.phone.code-sent" });
    return {};
}

/**
 * Spend a confirmation code. Takes `{ id, code }`; a bare code is the shape a
 * page loaded before several numbers existed sends, and confirms the primary.
 */
export async function verifyPhoneFor(userId: string, input: unknown): Promise<ActionResult> {
    const parsed = verifyPhoneSchema.safeParse(typeof input === "string" ? { code: input } : input);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.enterCode");
    const throttle = await rateLimit(`phone-check:${userId}`, CODE_CHECK_LIMIT, CODE_CHECK_WINDOW_MS);
    if (!throttle.ok) {
        const t = await getTranslations("accountSecurity");
        return { error: t("errors.tooManyAttempts", { minutes: Math.ceil(throttle.retryAfterMs / 60000) }) };
    }
    const phone = await prisma.userPhone.findFirst({
        where: parsed.data.id ? { id: parsed.data.id, userId } : { userId },
        orderBy: [{ primary: "desc" }, { createdAt: "asc" }],
        select: { phone: true }
    });
    const result = await verifyPhoneCode(auth, userId, parsed.data.code, parsed.data.id, {
        mayTakeFrom: (owner) => mayLosePhone(owner, phone?.phone ?? "")
    });
    const masked = phone ? maskPhone(phone.phone) : "";
    for (const owner of result.takenFrom ?? []) {
        // Recorded against the account that lost it, with no actor: the history
        // of the one that proved the phone must not show that anybody had it.
        await recordAudit({ actorId: null, action: "account.phone.taken", targetType: "user", targetId: owner });
        await notifyPhoneClaimed(owner, masked, "taken").catch((error: unknown) => {
            console.error("polaris: could not tell an account its number moved:", error);
        });
    }
    for (const owner of result.keptBy ?? []) {
        await notifyPhoneClaimed(owner, masked, "kept").catch((error: unknown) => {
            console.error("polaris: could not tell an account somebody holds its number:", error);
        });
    }
    if (!result.error) {
        await recordAudit({ actorId: userId, action: "account.phone.verified" });
        revalidatePath("/account/security", "layout");
    }
    return localized({ error: result.error });
}

/**
 * Whether an account may lose a number somebody else just proved they hold.
 * Yes when it keeps another confirmed number (codes go there instead) or has no
 * second step; otherwise only when a way to finish signing in survives that
 * does not go through a phone number - an authenticator, an email or Telegram
 * code, approval from the mobile app. Losing the number would otherwise lock
 * the account out, so it keeps it, as Signal's registration lock keeps one.
 */
export async function mayLosePhone(ownerId: string, phone: string): Promise<boolean> {
    const others = await prisma.userPhone.count({
        where: { userId: ownerId, phone: { not: phone }, verifiedAt: { not: null } }
    });
    if (others > 0) return true;
    if (!(await twoFactorEnabled(ownerId))) return true;
    const [options, approval] = await Promise.all([challengeOptions(ownerId), phoneCanApprove(ownerId)]);
    return approval || options.methods.some((entry) => entry.method !== "sms" && entry.method !== "whatsapp");
}
