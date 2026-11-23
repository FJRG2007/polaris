/**
 * Writing, confirming and removing the phone number on an account, for a caller
 * that has already been resolved.
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
import { otpCodeField, phoneField, TWO_FACTOR_CODE_TTL_MINUTES } from "@polaris/core";
import { issuePhoneCode, removeUserPhone, setUserPhone, verifyPhoneCode } from "@polaris/auth";

type ActionResult = { error?: string };

/** How often one account may ask for a confirmation code, and how often it may
 *  guess at one. Both are per account rather than per address: the number is the
 *  thing being protected, and it does not change between attempts. */
export const CODE_SEND_LIMIT = 5;
export const CODE_SEND_WINDOW_MS = 15 * 60 * 1000;
export const CODE_CHECK_LIMIT = 10;
export const CODE_CHECK_WINDOW_MS = 15 * 60 * 1000;

const setPhoneSchema = z.object({
    phone: phoneField,
    password: z.string().min(1, "Password is required")
});

export async function setPhoneFor(userId: string, input: unknown): Promise<ActionResult> {
    const parsed = setPhoneSchema.safeParse(input);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.checkForm");
    const result = await setUserPhone(auth, userId, parsed.data.phone, parsed.data.password);
    if (!result.error) {
        await recordAudit({ actorId: userId, action: "account.phone.set" });
        revalidatePath("/account/security", "layout");
    }
    return localized(result);
}

export async function removePhoneFor(userId: string, password: unknown): Promise<ActionResult> {
    const result = await removeUserPhone(auth, userId, String(password ?? ""));
    if (!result.error) {
        await recordAudit({ actorId: userId, action: "account.phone.removed" });
        revalidatePath("/account/security", "layout");
    }
    return localized(result);
}

/**
 * Send a confirmation code to the number on the account.
 *
 * It goes the way a second-factor code would - the deployment's WhatsApp code
 * sender, or the user's own connected channel on an older setup, else the SMS
 * code sender - so confirming the number and confirming the route are the same act.
 */
export async function sendPhoneCodeFor(userId: string): Promise<ActionResult> {
    const t = await getTranslations("accountSecurity");
    const throttle = await rateLimit(`phone-code:${userId}`, CODE_SEND_LIMIT, CODE_SEND_WINDOW_MS);
    if (!throttle.ok) {
        return { error: t("errors.tooManyCodes", { minutes: Math.ceil(throttle.retryAfterMs / 60000) }) };
    }

    const route = await phoneCodeRoute(userId);
    if (!route) return { error: t("errors.connectWhatsAppFirst") };

    const issued = await issuePhoneCode(auth, userId);
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

export async function verifyPhoneFor(userId: string, code: unknown): Promise<ActionResult> {
    const parsed = otpCodeField.safeParse(code);
    if (!parsed.success) return firstIssue(parsed.error.issues, "errors.enterCode");
    const throttle = await rateLimit(`phone-check:${userId}`, CODE_CHECK_LIMIT, CODE_CHECK_WINDOW_MS);
    if (!throttle.ok) {
        const t = await getTranslations("accountSecurity");
        return { error: t("errors.tooManyAttempts", { minutes: Math.ceil(throttle.retryAfterMs / 60000) }) };
    }
    const result = await verifyPhoneCode(auth, userId, parsed.data);
    if (!result.error) {
        await recordAudit({ actorId: userId, action: "account.phone.verified" });
        revalidatePath("/account/security", "layout");
    }
    return localized(result);
}
