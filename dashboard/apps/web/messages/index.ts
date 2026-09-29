/**
 * The dashboard's catalogs, every locale, as one set.
 *
 * Server-side only in practice: importing this puts every namespace of every
 * locale into whatever bundle does it. The browser receives only the namespaces
 * a screen asked for, through `<Messages>` (see docs/i18n.md) - a client
 * component reaches its strings with `useTranslations`, never through here.
 *
 * A new locale is its folder plus one line below; the type of `defineCatalogs`
 * refuses to compile until every locale in the registry has a line.
 */

import enUS from "./en-US";
import esES from "./es-ES";
import { defineCatalogs } from "@polaris/core";

export const webCatalogs = defineCatalogs({ "en-US": enUS, "es-ES": esES });

/** The source catalog's shape: every namespace and every key a screen may ask for. */
export type WebNamespaces = typeof enUS;
