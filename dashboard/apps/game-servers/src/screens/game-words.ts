/**
 * The app's words for a server action or a route: the same catalogs as the
 * screens, in the language of whoever is asking.
 */

import { host } from "@polaris/app-host";
import { gameCatalogs, type GameKey, type GameNamespace } from "../../messages";
import type { GameText } from "./game-text";

/** One namespace's translator, in the requester's language. */
export async function gameWords<N extends GameNamespace>(namespace: N): Promise<GameText<N>> {
    return gameCatalogs.translator(await host.i18nRequest.getLocale(), namespace);
}

/**
 * A schema is built once, when its module loads, where nobody is asking yet -
 * so a refine names its words as `namespace:key` (`schemaWords`) and they are
 * put into the requester's language when the parse fails (`issueText`).
 */
export function schemaWords<N extends GameNamespace>(namespace: N, key: GameKey<N>): string {
    return `${namespace}:${key}`;
}

/** A failed parse's message, in the requester's language when it names one of
 *  the app's keys; any other message as it is. */
export async function issueText(message: string | undefined): Promise<string | undefined> {
    const named = message?.match(/^(\w+):([\w.]+)$/);
    if (!named || !gameCatalogs.namespaces.includes(named[1] as GameNamespace)) return message;
    return gameCatalogs.translate(
        await host.i18nRequest.getLocale(),
        `${named[1]}.${named[2]}` as Parameters<typeof gameCatalogs.translate>[1]
    );
}
