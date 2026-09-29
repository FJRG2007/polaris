/**
 * Mail's words in the language of whoever is reading this request.
 *
 * The request layer is imported when asked for rather than at the top: the
 * modules that call this also run in the send queue and the sync, with no
 * request at all, and loading it there would load the session with it. Where it
 * cannot load - a job, a test - the default language answers.
 */

import { DEFAULT_LOCALE } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";
import type { NamespaceTranslator } from "@/lib/i18n/types";

export async function readerMailWords(): Promise<NamespaceTranslator<"mail">> {
    try {
        return await (await import("@/lib/i18n/request")).getTranslations("mail");
    } catch {
        return translatorFor(DEFAULT_LOCALE, "mail");
    }
}
