/**
 * Status pages' words on the server: the reader's language from the host, the
 * messages from the app's own catalogs. See dashboard/docs/i18n.md.
 */

import { host } from "@polaris/app-host";
import type { Translator } from "@polaris/core";
import { statusCatalogs, type StatusKey } from "../../messages";

export type StatusTranslator = Translator<StatusKey>;

/** The translator for whoever is reading this request. */
export async function statusT(): Promise<StatusTranslator> {
    return statusCatalogs.translator(await host.i18nRequest.getLocale(), "statusPages");
}
