/**
 * Translate's catalogs, every locale, as one set. The app cannot import the
 * dashboard's, so it ships its own and builds them with the same function.
 */

import enUS from "./en-US";
import esES from "./es-ES";
import { defineCatalogs, type MessageKey } from "@polaris/core";

export const translateCatalogs = defineCatalogs({ "en-US": enUS, "es-ES": esES });

/** Every key in the `translate` namespace. */
export type TranslateKey = MessageKey<(typeof enUS)["translate"]>;
