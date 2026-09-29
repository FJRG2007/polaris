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
import { gameMessageIn } from "../lib/game-message";
import { playerWords, type PlayerWords } from "../lib/player-vocabulary";

export type GameText<N extends GameNamespace> = Translator<GameKey<N>>;

/** One namespace's translator, in the page's language. */
export function useGameText<N extends GameNamespace>(namespace: N): GameText<N> {
    return gameCatalogs.translator(hostUi.i18nProvider.useLocale(), namespace);
}

/** The catalog key for each screen, by the name the dashboard's tab list gives it. */
const TAB_WORDS: Readonly<Record<string, GameKey<"games">>> = {
    Overview: "tabs.overview",
    Console: "tabs.console",
    Announce: "tabs.announce",
    "Side panel": "tabs.panel",
    "Linked chat": "tabs.chat",
    Events: "tabs.events",
    Challenges: "tabs.challenges",
    Players: "tabs.players",
    World: "tabs.world",
    Rules: "tabs.rules",
    Mods: "tabs.mods",
    Resources: "tabs.resources",
    Usage: "tabs.usage",
    Security: "tabs.security",
    "Anti-cheat": "tabs.anticheat",
    Access: "tabs.access",
    Schedule: "tabs.schedule",
    Settings: "tabs.settings"
};

/**
 * A server screen's name on the tab bar, in the reader's language.
 *
 * The list of screens is the dashboard's (`tabs.ts`), in English, because the
 * rail and the route read it as data; the words on this app's own tab bar are
 * this app's. A screen with no word here yet keeps the name it came with.
 */
export function useTabWords(): (label: string) => string {
    const t = useGameText("games");
    return (label) => {
        const key = TAB_WORDS[label];
        return key ? t(key) : label;
    };
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
 * A message that may carry one of the app's keys (see `lib/game-message`) - a
 * failed parse's, a status read on the server - in the reader's language; any
 * other text as it is. The browser's half of `issueText`.
 */
export function useSchemaText(): (message: string | null | undefined) => string | undefined {
    const locale = hostUi.i18nProvider.useLocale();
    return (message) =>
        message === undefined || message === null ? undefined : gameMessageIn(locale, message);
}
