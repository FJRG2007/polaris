/**
 * Hospitality' words on the server: the reader's language from the host, the
 * messages from the app's own catalogs. See dashboard/docs/i18n.md.
 */

import { host } from "@polaris/app-host";
import type { Translator } from "@polaris/core";
import { hospitalityCatalogs, type HospitalityKey } from "../../messages";

export type HospitalityTranslator = Translator<HospitalityKey>;

/** The translator for whoever is reading this request. */
export async function hospitalityT(): Promise<HospitalityTranslator> {
    return hospitalityCatalogs.translator(
        await host.i18nRequest.getLocale(),
        "hospitality",
        await host.i18nRequest.getClient()
    );
}
