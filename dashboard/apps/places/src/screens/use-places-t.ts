/**
 * Places' words in the browser, in the language the page is drawn in.
 *
 *     const t = usePlacesT();
 *     <h2>{t("cameras.title")}</h2>
 */

import { hostUi } from "@polaris/app-host/client";
import type { PlacesTranslator } from "../lib/i18n";
import { placesCatalogs } from "../../messages";

export function usePlacesT(): PlacesTranslator {
    return placesCatalogs.translator(hostUi.i18nProvider.useLocale(), "places");
}
