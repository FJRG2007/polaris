/**
 * Mail's words in the language of whoever is reading this request - or the
 * default language in the send queue and the sync, which run with none.
 */

import { readerWords } from "@/lib/i18n/reader-words";
import type { NamespaceTranslator } from "@/lib/i18n/types";

export function readerMailWords(): Promise<NamespaceTranslator<"mail">> {
    return readerWords("mail");
}
