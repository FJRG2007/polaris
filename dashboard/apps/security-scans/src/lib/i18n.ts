/**
 * Security scans' words on the server: the reader's language from the host,
 * the messages from the app's own catalogs.
 */

import { host } from "@polaris/app-host";
import { DEFAULT_LOCALE, type Translator } from "@polaris/core";
import { securityCatalogs, type SecurityKey } from "../../messages";

export type SecurityTranslator = Translator<SecurityKey>;

export async function securityT(): Promise<SecurityTranslator> {
    return securityCatalogs.translator(await host.i18nRequest.getLocale(), "security");
}

/** One person's words, for what reaches them outside a request (the bell). */
export async function securityTFor(userId: string): Promise<SecurityTranslator> {
    try {
        return securityCatalogs.translator(
            await host.i18nLocaleService.getUserLocale(userId),
            "security"
        );
    } catch {
        return securityCatalogs.translator(DEFAULT_LOCALE, "security");
    }
}
