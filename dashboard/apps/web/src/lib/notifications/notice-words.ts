/**
 * The words a notice is written in: the recipient's language.
 *
 * A notice is stored as the sentence it says, so it is worded for the account
 * that will read it rather than for the request that raised it. A language that
 * cannot be read - the account is gone, the lookup failed - is no reason to lose
 * the notice, so it falls back to the default.
 */

import { DEFAULT_LOCALE } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";
import { getUserLocale } from "@/lib/i18n/locale-service";
import type { Namespace, NamespaceTranslator } from "@/lib/i18n/types";

export async function wordsFor<N extends Namespace>(userId: string, namespace: N): Promise<NamespaceTranslator<N>> {
    const locale = await getUserLocale(userId).catch(() => DEFAULT_LOCALE);
    return translatorFor(locale, namespace);
}
