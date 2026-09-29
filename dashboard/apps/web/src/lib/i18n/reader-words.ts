/**
 * A namespace's words in the language of whoever is reading this request, for a
 * module that also runs with no request at all.
 *
 * The request layer is imported when asked for rather than at the top: the
 * modules that call this also run in jobs and queues, and loading it there would
 * load the session with it. Where it cannot load - a job, a test - the default
 * language answers.
 */

import { DEFAULT_LOCALE } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";
import type { Namespace, NamespaceTranslator } from "@/lib/i18n/types";

export async function readerWords<N extends Namespace>(namespace: N): Promise<NamespaceTranslator<N>> {
    try {
        return await (await import("@/lib/i18n/request")).getTranslations(namespace);
    } catch {
        return translatorFor(DEFAULT_LOCALE, namespace);
    }
}
