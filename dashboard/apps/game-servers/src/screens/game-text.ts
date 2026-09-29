/**
 * The app's words, from its own catalogs (`messages/<locale>/<namespace>.json`),
 * in the language the page is drawn in.
 *
 * The host hands the page's locale down; the app cannot import the dashboard's
 * catalogs, so it translates with its own. A translator is built once per
 * locale and namespace and kept, so this is as cheap as reading a context.
 */

import type { Translator } from "@polaris/core";
import { hostUi } from "@polaris/app-host/client";
import { gameCatalogs, type GameKey, type GameNamespace } from "../../messages";
import { timeoutLeft } from "../lib/player-timeout";

export type GameText<N extends GameNamespace> = Translator<GameKey<N>>;

/** One namespace's translator, in the page's language. */
export function useGameText<N extends GameNamespace>(namespace: N): GameText<N> {
    return gameCatalogs.translator(hostUi.i18nProvider.useLocale(), namespace);
}

/** How long a timeout has left, in the reader's words: "40m left". */
export function timeoutText(t: GameText<"games">, iso: string): string {
    return t("timeout.left", timeoutLeft(iso));
}
