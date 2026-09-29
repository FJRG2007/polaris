/**
 * The dashboard's translation types, derived from the en-US catalog.
 *
 * Type-only, so a client component may import from here without pulling a
 * single catalog into its bundle.
 */

import type { WebNamespaces } from "../../../messages";
import type { MessageKey, QualifiedKey, Translator } from "@polaris/core";

/** A namespace of the dashboard's catalogs: `"common"`, `"nav"`, `"account"`. */
export type Namespace = keyof WebNamespaces & string;

/** A key inside one namespace: `"preferences.title"`. */
export type NamespaceKey<N extends Namespace> = MessageKey<WebNamespaces[N]>;

/** A key with its namespace in front: `"account.preferences.title"`. */
export type WebKey = QualifiedKey<WebNamespaces>;

/** What `useTranslations("account")` and `getTranslations("account")` return. */
export type NamespaceTranslator<N extends Namespace> = Translator<NamespaceKey<N>>;
