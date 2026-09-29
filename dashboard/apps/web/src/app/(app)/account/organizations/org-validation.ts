/**
 * The words the organization schemas in `@polaris/core` refuse a value with, in
 * the reader's language.
 *
 * The schemas stay English (the browser and the server share them), so the
 * messages only these screens meet are mapped here, and everything else goes to
 * the shared `validationMessage`, which passes through what it does not know.
 * Pure, so the forms and the actions use it with the translators they hold.
 */

import { validationMessage } from "@/components/i18n/validation-message";
import type { NamespaceKey, NamespaceTranslator } from "@/lib/i18n/types";

const ORG_MESSAGES: ReadonlyMap<string, NamespaceKey<"accountOrgs">> = new Map<string, NamespaceKey<"accountOrgs">>([
    ["Enter a name", "validation.enterName"],
    ["Cannot start or end with -", "validation.handleEdges"],
    ["Use letters, numbers or -", "validation.roleHandleCharacters"],
    ["Enter an email or a username", "validation.enterIdentifier"],
    ["Enter an amount like 250", "validation.amountLike"],
    ["Enter an amount", "validation.enterAmount"],
    ["A budget has to be more than zero", "validation.budgetPositive"],
    ["That is more than Polaris can track", "validation.budgetTooLarge"]
]);

export function orgValidationMessage(
    t: NamespaceTranslator<"accountOrgs">,
    tv: NamespaceTranslator<"validation">,
    message: string
): string;
export function orgValidationMessage(
    t: NamespaceTranslator<"accountOrgs">,
    tv: NamespaceTranslator<"validation">,
    message: string | undefined
): string | undefined;
export function orgValidationMessage(
    t: NamespaceTranslator<"accountOrgs">,
    tv: NamespaceTranslator<"validation">,
    message: string | undefined
): string | undefined {
    if (message === undefined) return undefined;
    const key = ORG_MESSAGES.get(message);
    return key ? t(key) : validationMessage(tv, message);
}
