/**
 * Places' catalogs, every locale, as one set. The app cannot import the
 * dashboard's, so it ships its own and builds them with the same function.
 */

import enUS from "./en-US";
import esES from "./es-ES";
import { defineCatalogs, type MessageKey } from "@polaris/core";

export const placesCatalogs = defineCatalogs({ "en-US": enUS, "es-ES": esES });

/** Every key in the `places` namespace. */
export type PlacesKey = MessageKey<(typeof enUS)["places"]>;

/** The source language, for code with no reader to ask - a log line, a test, a
 *  default. A screen never uses this. */
export const englishPlaces = placesCatalogs.translator("en-US", "places");
