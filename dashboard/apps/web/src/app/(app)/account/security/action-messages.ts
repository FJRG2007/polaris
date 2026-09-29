/**
 * The Security and Sessions actions' replies, in the language of whoever pressed
 * the button.
 *
 * An action's own sentences come from `accountSecurity` directly. A refusal that
 * was written elsewhere - the new-device gate, @polaris/auth, the step-up check,
 * a shared schema - is passed through `localized`, which translates the ones
 * `knownMessage` knows and leaves the rest as they were.
 *
 * Server-only: it reads the request's language.
 */

import { knownMessage } from "./known-sentences";
import { getTranslations } from "@/lib/i18n/request";

/** Translate a reply's error, when it has one. Anything else in it is untouched. */
export async function localized<T extends { error?: string }>(result: T): Promise<T> {
    if (!result.error) return result;
    const [t, tv] = await Promise.all([getTranslations("accountSecurity"), getTranslations("validation")]);
    return { ...result, error: knownMessage(t, tv, result.error) };
}

/** A schema's first complaint, translated, or the given fallback. */
export async function firstIssue(
    issues: readonly { message: string }[],
    fallback: "errors.checkForm" | "errors.unreadable" | "errors.enterCode"
): Promise<{ error: string }> {
    const message = issues[0]?.message;
    if (message) return localized({ error: message });
    return { error: (await getTranslations("accountSecurity"))(fallback) };
}
