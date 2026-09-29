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
import { playerWords, type PlayerWords } from "../lib/player-vocabulary";

export type GameText<N extends GameNamespace> = Translator<GameKey<N>>;

/** One namespace's translator, in the page's language. */
export function useGameText<N extends GameNamespace>(namespace: N): GameText<N> {
    return gameCatalogs.translator(hostUi.i18nProvider.useLocale(), namespace);
}

/** How long a timeout has left, in the reader's words: "40m left". */
export function timeoutText(t: GameText<"games">, iso: string): string {
    return t("timeout.left", timeoutLeft(iso));
}

/** The players screens' shared words, in the reader's language. */
export function usePlayerWords(): PlayerWords {
    return playerWords(useGameText("games"));
}

/** A Minecraft colour code's name, in the reader's language - the code is the
 *  game's, the name is only a label for it. */
export function colorName(t: GameText<"games">, code: string): string {
    return t(`motd.colors.${code}` as GameKey<"games">);
}

/** A Minecraft style code's name, in the reader's language. */
export function styleName(t: GameText<"games">, code: string): string {
    return t(`motd.styles.${code}` as GameKey<"games">);
}

/**
 * A failed parse's message, in the reader's language when it names one of the
 * app's keys (`namespace:key`, see `schemaWords`); any other message as it is.
 * The browser's half of `issueText`, for a schema a screen checks before it sends.
 */
export function useSchemaText(): (message: string | undefined) => string | undefined {
    const locale = hostUi.i18nProvider.useLocale();
    return (message) => {
        const named = message?.match(/^(\w+):([\w.]+)$/);
        if (!named || !gameCatalogs.namespaces.includes(named[1] as GameNamespace)) return message;
        return gameCatalogs.translate(
            locale,
            `${named[1]}.${named[2]}` as Parameters<typeof gameCatalogs.translate>[1]
        );
    };
}
