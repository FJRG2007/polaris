/**
 * Security scans' words on the server: the reader's language from the host,
 * the messages from the app's own catalogs.
 */

import { host } from "@polaris/app-host";
import type { Translator } from "@polaris/core";
import { securityCatalogs, type SecurityKey } from "../../messages";

export type SecurityTranslator = Translator<SecurityKey>;

export async function securityT(): Promise<SecurityTranslator> {
    return securityCatalogs.translator(await host.i18nRequest.getLocale(), "security");
}
