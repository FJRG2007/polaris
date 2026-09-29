/**
 * The app's words for a server action or a route: the same catalogs as the
 * screens, in the language of whoever is asking.
 */

import { host } from "@polaris/app-host";
import { gameCatalogs, type GameNamespace } from "../../messages";
import type { GameText } from "./game-text";

/** One namespace's translator, in the requester's language. */
export async function gameWords<N extends GameNamespace>(namespace: N): Promise<GameText<N>> {
    return gameCatalogs.translator(await host.i18nRequest.getLocale(), namespace);
}
