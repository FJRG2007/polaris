/**
 * Cloud servers' words on the server: the reader's language from the host, the
 * messages from the app's own catalogs.
 */

import { host } from "@polaris/app-host";
import type { Translator } from "@polaris/core";
import { cloudCatalogs, type CloudKey } from "../../messages";

export type CloudTranslator = Translator<CloudKey>;

/** The translator for whoever is reading this request. */
export async function cloudT(): Promise<CloudTranslator> {
    return cloudCatalogs.translator(await host.i18nRequest.getLocale(), "cloudServers");
}
