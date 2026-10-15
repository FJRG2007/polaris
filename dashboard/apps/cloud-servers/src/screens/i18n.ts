/**
 * Cloud servers' words in the browser, in the language the page is drawn in.
 */

import { hostUi } from "@polaris/app-host/client";
import type { CloudTranslator } from "../lib/i18n";
import { cloudCatalogs } from "../../messages";

export function useCloudT(): CloudTranslator {
    return cloudCatalogs.translator(hostUi.i18nProvider.useLocale(), "cloudServers");
}
