/**
 * Hospitality's catalogs, every locale, as one set. The app cannot import the
 * dashboard's, so it ships its own and builds them with the same function.
 */

import enUS from "./en-US";
import esES from "./es-ES";
import { defineCatalogs, type MessageKey } from "@polaris/core";

export const hospitalityCatalogs = defineCatalogs({ "en-US": enUS, "es-ES": esES });

/** Every key in the `hospitality` namespace. */
export type HospitalityKey = MessageKey<(typeof enUS)["hospitality"]>;
