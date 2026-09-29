/**
 * A sentence the app's server code says without knowing who will read it.
 *
 * A status read in a background job, a schema built when its module loads, a
 * refusal thrown three calls below the request - none of them has a reader to
 * ask for a language. So they carry the catalog key instead, as
 * `namespace:key`, with `?` and the values as JSON when the sentence has any,
 * and whatever finally shows it - a screen, or a server action answering the
 * request - writes it in the reader's language with `gameMessageIn`. Any other
 * text passes through as it is, so a message from the game itself, or from
 * somewhere that was never keyed, is still shown.
 */

import type { Locale, MessageParams } from "@polaris/core";
import { gameCatalogs, type GameKey, type GameNamespace } from "../../messages";

/** A catalog key, carried as text until somebody reads it. */
export function gameMessage<N extends GameNamespace>(
    namespace: N,
    key: GameKey<N>,
    params?: Readonly<Record<string, string | number>>
): string {
    const named = `${namespace}:${key}`;
    return params && Object.keys(params).length > 0 ? `${named}?${JSON.stringify(params)}` : named;
}

/** What a carried message names, or null for text that is not one. */
export function readGameMessage(
    text: string
): { namespace: GameNamespace; key: string; params: MessageParams | undefined } | null {
    const named = /^(\w+):([\w.]+)(?:\?(\{.*\}))?$/s.exec(text);
    if (!named || !gameCatalogs.namespaces.includes(named[1] as GameNamespace)) return null;
    let params: MessageParams | undefined;
    if (named[3]) {
        try {
            params = JSON.parse(named[3]) as MessageParams;
        } catch {
            return null;
        }
    }
    return { namespace: named[1] as GameNamespace, key: named[2]!, params };
}

/** A message in one language: a carried key written out, any other text as it is.
 *  A value that is itself a carried key - a status with a step appended - is
 *  written out first. */
export function gameMessageIn(locale: Locale, text: string): string {
    const named = readGameMessage(text);
    if (!named) return text;
    const params = named.params
        ? Object.fromEntries(
              Object.entries(named.params).map(([name, value]) => [
                  name,
                  typeof value === "string" ? gameMessageIn(locale, value) : value
              ])
          )
        : undefined;
    return gameCatalogs.translate(
        locale,
        `${named.namespace}.${named.key}` as Parameters<typeof gameCatalogs.translate>[1],
        params
    );
}
