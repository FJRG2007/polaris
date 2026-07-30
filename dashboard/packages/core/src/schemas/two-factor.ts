/**
 * The ways a second factor can reach the person signing in, and the settings
 * that decide which of them an account will accept.
 *
 * The authenticator is the baseline: it is what arms the factor in the first
 * place, it needs nothing from the deployment, and it cannot be turned off while
 * the factor is on - an account whose only remaining method depended on a mail
 * channel or a messaging bridge would be locked out the moment that broke. Every
 * other method is opt-in and delivers a code Polaris has to send somewhere, so
 * each one costs a proved address and a working way to reach it.
 *
 * Shared by the challenge screen, the settings page and the server, so the list
 * of methods and what each one requires is written down once.
 */

import { z } from "zod";

/** Every second-factor method, in the order the challenge screen offers them. */
export const TWO_FACTOR_METHODS = ["totp", "email", "whatsapp"] as const;

export type TwoFactorMethod = (typeof TWO_FACTOR_METHODS)[number];

/** The methods that send a code, as opposed to the authenticator that shows one. */
export const TWO_FACTOR_DELIVERY_METHODS = ["email", "whatsapp"] as const;

export type TwoFactorDeliveryMethod = (typeof TWO_FACTOR_DELIVERY_METHODS)[number];

/** How a method presents itself wherever it is listed. */
export interface TwoFactorMethodInfo {
    id: TwoFactorMethod;
    label: string;
    /** One line on the settings row, and under the option on the challenge. */
    description: string;
    /** What has to exist before the method can be turned on. */
    requirement: string;
}

export const TWO_FACTOR_METHOD_INFO: Record<TwoFactorMethod, TwoFactorMethodInfo> = {
    totp: {
        id: "totp",
        label: "Authenticator app",
        description: "A code your phone generates on its own, with no network involved.",
        requirement: "Set up while turning two-step verification on."
    },
    email: {
        id: "email",
        label: "Email code",
        description: "A code sent to a confirmed address on your account.",
        requirement: "A confirmed address, and an email channel Polaris can send from."
    },
    whatsapp: {
        id: "whatsapp",
        label: "WhatsApp code",
        description: "A code sent to your confirmed number as a WhatsApp message.",
        requirement: "A confirmed phone number and one of your own WhatsApp channels connected."
    }
};

/**
 * How long a sent code stays good. Long enough to survive a mail queue or a
 * message that lands on a phone in another room, short enough that a code left
 * on a screen is not a standing key.
 */
export const TWO_FACTOR_CODE_TTL_MINUTES = 10;

/** Wrong guesses one code tolerates before it has to be asked for again. */
export const TWO_FACTOR_CODE_ATTEMPTS = 5;

/**
 * Carries the method the user picked on the challenge screen. better-auth's
 * send-otp endpoint has no field for it - the body is a fixed shape it validates
 * itself - so the choice rides on the request as a header and is read back in the
 * send callback. It is only ever a routing hint: the server still checks the
 * method against what the account has turned on, and falls back to the preferred
 * one when the header is absent or names something the account will not accept.
 */
export const TWO_FACTOR_METHOD_HEADER = "x-polaris-2fa-method";

export const twoFactorMethodField = z.enum(TWO_FACTOR_METHODS);

/** Which methods the account accepts, and which one it offers first. */
export const twoFactorPreferencesSchema = z
    .object({
        /** Delivery methods turned on. The authenticator is always accepted. */
        methods: z
            .array(z.enum(TWO_FACTOR_DELIVERY_METHODS))
            .max(TWO_FACTOR_DELIVERY_METHODS.length)
            .transform((values) => Array.from(new Set(values))),
        preferred: twoFactorMethodField
    })
    .refine(
        (value) => value.preferred === "totp" || value.methods.includes(value.preferred as TwoFactorDeliveryMethod),
        { message: "Turn the method on before making it the default", path: ["preferred"] }
    );

export type TwoFactorPreferencesInput = z.infer<typeof twoFactorPreferencesSchema>;

/**
 * A phone number in international form. Stored and sent exactly as written: the
 * messaging bridge addresses WhatsApp by digits, and guessing at a country code
 * for a bare local number would send someone else's code to a stranger.
 */
export const phoneField = z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{6,14}$/, "Use the international form, for example +34600111222");

/** A code Polaris sent, whether to an address or a phone. */
export const otpCodeField = z
    .string()
    .trim()
    .regex(/^\d{6}$/, "Enter the 6-digit code");

/**
 * Show enough of an address to recognize it without printing it in full on a
 * screen anyone standing behind an unproved sign-in can read.
 */
export function maskEmail(email: string): string {
    const at = email.lastIndexOf("@");
    if (at <= 0) return "***";
    const name = email.slice(0, at);
    const domain = email.slice(at + 1);
    const head = name.slice(0, name.length > 2 ? 2 : 1);
    return `${head}${"*".repeat(Math.max(3, name.length - head.length))}@${domain}`;
}

/** The same, for a number: the country prefix and the last two digits. */
export function maskPhone(phone: string): string {
    if (phone.length <= 5) return "***";
    return `${phone.slice(0, 3)}${"*".repeat(phone.length - 5)}${phone.slice(-2)}`;
}
