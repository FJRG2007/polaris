/**
 * Words for somebody who is not the one asking: the owner a notification goes
 * to, written in their own language rather than the language of whatever
 * background pass noticed the thing.
 */

import { host } from "@polaris/app-host";
import type { Locale, Translator } from "@polaris/core";
import { gameCatalogs, type GameKey, type GameNamespace } from "../../messages";

/** The account's language, or English when it cannot be read - a notification
 *  in English beats no notification. */
export async function ownerLocale(userId: string): Promise<Locale> {
    try {
        return await host.i18nLocaleService.getUserLocale(userId);
    } catch {
        return "en-US";
    }
}

/** One namespace's translator, in the account's language. */
export async function ownerWords<N extends GameNamespace>(
    userId: string,
    namespace: N
): Promise<Translator<GameKey<N>>> {
    return gameCatalogs.translator(await ownerLocale(userId), namespace);
}

/** The language of whoever the current request is for, or English outside one -
 *  for lib code that answers a request but cannot tell whether it is in one. */
export async function readerLocale(): Promise<Locale> {
    try {
        return await host.i18nRequest.getLocale();
    } catch {
        return "en-US";
    }
}
