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
import { otpCodeField, phoneField, TWO_FACTOR_CODE_TTL_MINUTES } from "@polaris/core";
import { addUserPhone, issuePhoneCode, promoteUserPhone, removeUserPhone, verifyPhoneCode } from "@polaris/auth";

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
 * A number another account has confirmed is answered exactly like one a code
 * went to, and nothing is sent (see issuePhoneCode).
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
    if (issued.held) {
        await recordAudit({ actorId: userId, action: "account.phone.code-sent" });
        return {};
    }
    if (issued.error || !issued.code || !issued.phone) {
        return issued.error ? localized({ error: issued.error }) : { error: t("known.addPhoneFirst") };
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
    const result = await verifyPhoneCode(auth, userId, parsed.data.code, parsed.data.id);
    if (!result.error) {
        await recordAudit({ actorId: userId, action: "account.phone.verified" });
        revalidatePath("/account/security", "layout");
    }
    return localized(result);
}
