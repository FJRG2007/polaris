/**
 * The CRM's words in the browser, in the language the page is drawn in.
 *
 *     const t = useCrmT();
 *     <h2>{t("objects.companies.plural")}</h2>
 */

import { hostUi } from "@polaris/app-host/client";
import type { CrmTranslator } from "../lib/i18n";
import { crmCatalogs } from "../../messages";

export function useCrmT(): CrmTranslator {
    return crmCatalogs.translator(hostUi.i18nProvider.useLocale(), "crm");
}
