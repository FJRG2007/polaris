/**
 * Translate's words on the server: the reader's language from the host, the
 * messages from the app's own catalogs. See dashboard/docs/i18n.md.
 */

import { host } from "@polaris/app-host";
import type { Translator } from "@polaris/core";
import { translateCatalogs, type TranslateKey } from "../../messages";

export type TranslateTranslator = Translator<TranslateKey>;

/** The translator for whoever is reading this request. */
export async function translateT(): Promise<TranslateTranslator> {
    return translateCatalogs.translator(await host.i18nRequest.getLocale(), "translate");
}
