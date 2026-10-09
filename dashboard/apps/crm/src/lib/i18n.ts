/**
 * The CRM's words on the server: the reader's language from the host, the
 * messages from the app's own catalogs. See dashboard/docs/i18n.md.
 */

import { host } from "@polaris/app-host";
import type { Translator } from "@polaris/core";
import { crmCatalogs, type CrmKey } from "../../messages";

export type CrmTranslator = Translator<CrmKey>;

/** The translator for whoever is reading this request. */
export async function crmT(): Promise<CrmTranslator> {
    return crmCatalogs.translator(await host.i18nRequest.getLocale(), "crm");
}
