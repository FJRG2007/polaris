/**
 * The app's words for a server action or a route: the same catalogs as the
 * screens, in the language of whoever is asking.
 */

import { host } from "@polaris/app-host";
import { gameCatalogs, type GameKey, type GameNamespace } from "../../messages";
import { gameMessage, gameMessageIn, readGameMessage } from "../lib/game-message";
import type { GameText } from "./game-text";

/** One namespace's translator, in the requester's language. */
export async function gameWords<N extends GameNamespace>(namespace: N): Promise<GameText<N>> {
    return gameCatalogs.translator(await host.i18nRequest.getLocale(), namespace);
}

/**
 * A schema is built once, when its module loads, where nobody is asking yet -
 * so a refine names its words as a carried key (`schemaWords`, which is
 * `gameMessage` from `lib/game-message`) and they are put into the requester's
 * language when the parse fails (`issueText`).
 */
export function schemaWords<N extends GameNamespace>(namespace: N, key: GameKey<N>): string {
    return gameMessage(namespace, key);
}

/** A message that may carry one of the app's keys - a failed parse's, a status
 *  from the lib - in the requester's language; any other text as it is. */
export async function issueText(message: string | undefined): Promise<string | undefined> {
    if (message === undefined) return undefined;
    return readGameMessage(message)
        ? gameMessageIn(await host.i18nRequest.getLocale(), message)
        : message;
}

/** A thrown message, in the requester's language when it carries one of the
 *  app's keys - which is what the lib throws - and as it is otherwise. */
export async function messageText(message: string): Promise<string> {
    return readGameMessage(message)
        ? gameMessageIn(await host.i18nRequest.getLocale(), message)
        : message;
}
