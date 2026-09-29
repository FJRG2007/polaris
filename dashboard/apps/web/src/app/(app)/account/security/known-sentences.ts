/**
 * The sentences the Security and Sessions screens show that were written
 * somewhere else - the new-device gate, @polaris/auth, the step-up check, the
 * shared schemas in @polaris/core - in the reader's language.
 *
 * Those modules have no reader to ask and stay the English source, so the words
 * are translated where they are shown, the way `validationMessage` does for the
 * shared field messages: a sentence this table knows comes back translated, and
 * anything else comes back as it was. English is therefore never changed by it,
 * and a sentence reworded at its source simply stops being translated here
 * rather than showing the wrong words.
 *
 * Pure and catalog-free, so a client form and a server action use it with the
 * translators they already hold.
 */

import * as core from "@polaris/core";
import { validationMessage } from "@/components/i18n/validation-message";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

type SecurityKey = NamespaceKey<"accountSecurity">;

/** Exact sentences, by the words their source writes them in. */
const EXACT: ReadonlyMap<string, SecurityKey> = new Map<string, SecurityKey>([
    // The new-device gate and the lockdown (lib/device-grace, lib/account-lifecycle).
    [
        "This browser did not say what it is, so it counts as new. Security settings stay locked from here.",
        "newDevice.unrecognized"
    ],
    ["Your account is locked down. Lift it under Security before changing anything else.", "known.lockedDown"],
    // @polaris/auth.
    ["Current password is incorrect.", "known.wrongPassword"],
    ["Name this passkey before adding it.", "known.passkeyUnnamed"],
    ["One of your passkeys is already called that.", "known.passkeyNameTaken"],
    ["No codes were issued. Try again.", "known.noCodesIssued"],
    ["Add a phone number first.", "known.addPhoneFirst"],
    ["That number is already confirmed.", "known.phoneAlreadyConfirmed"],
    ["Ask for a code first.", "known.askForCodeFirst"],
    ["That code has expired. Ask for a new one.", "known.codeExpired"],
    ["Too many wrong tries. Ask for a new code.", "known.tooManyWrongTries"],
    ["That code is not right.", "known.wrongCode"],
    // The step-up check (lib/step-up).
    ["That is not a way this account can confirm.", "known.notAWayToConfirm"],
    ["That password is not right.", "known.wrongStepUpPassword"],
    // Approving a waiting sign-in (lib/session-directory).
    ["That sign-in is no longer waiting.", "known.signInNotWaiting"],
    ["That PIN is not right.", "known.wrongPin"],
    // Reporting somebody (lib/safety-queue).
    ["You cannot report yourself.", "known.reportSelf"],
    ["That account could not be reported.", "known.reportFailed"],
    // A new password that is also the vault's (lib/vault/would-open).
    [
        "That is your vault's master password. If they are the same, whoever learns one has the vault as well.",
        "known.sameAsVault"
    ],
    // The successor directory (lib/successor-service).
    ["More than one account has that name - use their username or email address", "known.successorAmbiguous"],
    ["No account matches that username, name or email address", "known.successorNoMatch"],
    ["Name somebody else - you cannot succeed yourself", "known.successorSelf"],
    ["Could not name that successor", "known.successorFailed"],
    // Why a second-factor method cannot deliver (lib/two-factor-delivery).
    ["No confirmed address on your account.", "known.noConfirmedAddress"],
    ["Polaris has no email channel to send from.", "known.noEmailChannel"],
    ["Confirm a phone number on your profile first.", "known.confirmPhoneFirst"],
    ["None of your WhatsApp channels is connected.", "known.noWhatsAppChannel"],
    ["No authenticator is set up on this account.", "known.noAuthenticator"],
    ["Two-step verification is off.", "known.twoStepOff"],
    // The shared schemas behind these forms (@polaris/core).
    ["Use 4 to 6 digits", "known.pinDigits"],
    ["The PINs do not match", "known.pinsDiffer"],
    ["Unsupported lock timeout", "known.unsupportedLock"],
    ["Unsupported session lifetime", "known.unsupportedLifetime"],
    ["Unsupported wait", "known.unsupportedWait"],
    ["Answer is too short", "known.answerTooShort"],
    ["Answer is too long", "known.answerTooLong"],
    ["Question is too short", "known.questionTooShort"],
    ["Enter the 6-digit code", "known.enterCode"],
    ["Answer your security questions or use an authenticator code", "known.answerOrCode"],
    ["Turn the method on before making it the default", "known.methodOffDefault"],
    ["Use the international form, for example +34600111222", "known.phoneFormat"],
    ["Enter your password", "known.enterPassword"]
]);

/** Sentences with a number in them. */
const COUNTED: readonly (readonly [RegExp, (t: NamespaceTranslator<"accountSecurity">, match: RegExpExecArray) => string])[] = [
    [
        /^This account gives a new device (\d+) days? before it can change security settings\. This one has (\d+) days? left\.$/,
        (t, match) => t("newDevice.waiting", { grace: Number(match[1]), left: Number(match[2]) })
    ],
    [
        /^Keep the name under (\d+) characters\.$/,
        (t, match) => t("passkeys.nameTooLong", { max: Number(match[1]) })
    ],
    [
        /^New password must be at least (\d+) characters\.$/,
        (t, match) => t("known.passwordMinLength", { count: Number(match[1]) })
    ],
    [
        /^Too many codes asked for\. Try again in (\d+) minutes?\.$/,
        (t, match) => t("errors.tooManyCodes", { minutes: Number(match[1]) })
    ],
    [/^Set (\d+) questions$/, (t, match) => t("known.setQuestions", { count: Number(match[1]) })],
    [
        /^Too many attempts\. Try again in (\d+) minutes?\.$/,
        (t, match) => t("errors.tooManyAttempts", { minutes: Number(match[1]) })
    ]
];

/** The suggested recovery questions, in the order @polaris/core lists them. A
 *  stored question is the English text, so it is matched by its words. */
const QUESTION_SUGGESTIONS: readonly SecurityKey[] = [
    "questions.suggestions.pet",
    "questions.suggestions.city",
    "questions.suggestions.car",
    "questions.suggestions.sibling",
    "questions.suggestions.school",
    "questions.suggestions.street"
];

/** A recovery question as the reader should see it: a suggested one in their
 *  language, one they wrote themselves exactly as they wrote it. */
export function questionLabel(t: NamespaceTranslator<"accountSecurity">, question: string): string {
    const index = core.SECURITY_QUESTION_SUGGESTIONS.indexOf(question);
    const key = index >= 0 ? QUESTION_SUGGESTIONS[index] : undefined;
    return key ? t(key) : question;
}

/** The core method names, as the screens draw them. */
const METHOD_LABELS: Readonly<Record<core.TwoFactorMethod, SecurityKey>> = {
    totp: "methods.totp.label",
    email: "methods.email.label",
    whatsapp: "methods.whatsapp.label"
};

/** A two-factor method's name, in the reader's language. */
export function methodLabel(t: NamespaceTranslator<"accountSecurity">, method: core.TwoFactorMethod): string {
    return t(METHOD_LABELS[method]);
}

/**
 * A sentence from outside this area in the reader's language, or the sentence
 * itself when it is not one this table knows. Undefined stays undefined.
 */
export function knownMessage(
    t: NamespaceTranslator<"accountSecurity">,
    tv: NamespaceTranslator<"validation">,
    message: string
): string;
export function knownMessage(
    t: NamespaceTranslator<"accountSecurity">,
    tv: NamespaceTranslator<"validation">,
    message: string | undefined
): string | undefined;
export function knownMessage(
    t: NamespaceTranslator<"accountSecurity">,
    tv: NamespaceTranslator<"validation">,
    message: string | undefined
): string | undefined {
    if (message === undefined) return undefined;
    const key = EXACT.get(message);
    if (key) return t(key);
    for (const [pattern, say] of COUNTED) {
        const match = pattern.exec(message);
        if (match) return say(t, match);
    }
    return validationMessage(tv, message);
}
