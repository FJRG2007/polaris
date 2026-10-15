/**
 * Status pages' catalogs, every locale, as one set. The app cannot import the
 * dashboard's, so it ships its own and builds them with the same function.
 */

import enUS from "./en-US";
import esES from "./es-ES";
import { defineCatalogs, type MessageKey } from "@polaris/core";

export const statusCatalogs = defineCatalogs({ "en-US": enUS, "es-ES": esES });

/** Every key in the `statusPages` namespace. */
export type StatusKey = MessageKey<(typeof enUS)["statusPages"]>;
