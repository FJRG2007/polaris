/**
 * Places' words on the server: the reader's language from the host, the
 * messages from the app's own catalogs. See dashboard/docs/i18n.md.
 */

import { DEFAULT_LOCALE, type Locale, type Translator } from "@polaris/core";
import { host } from "@polaris/app-host";
import { placesCatalogs, type PlacesKey } from "../../messages";

export type PlacesTranslator = Translator<PlacesKey>;

/** The translator for whoever is reading this request. */
export async function placesT(): Promise<PlacesTranslator> {
    return placesCatalogs.translator(await host.i18nRequest.getLocale(), "places");
}

/** The translator for one account, with no request around it - a notification.
 *  A sweep or a job that cannot ask still says it, in the source language. */
export async function placesTFor(userId: string): Promise<PlacesTranslator> {
    try {
        return placesCatalogs.translator(await host.i18nLocaleService.getUserLocale(userId), "places");
    } catch {
        return placesCatalogs.translator(DEFAULT_LOCALE, "places");
    }
}

/** The translator for a locale already in hand. */
export function placesTIn(locale: Locale): PlacesTranslator {
    return placesCatalogs.translator(locale, "places");
}
