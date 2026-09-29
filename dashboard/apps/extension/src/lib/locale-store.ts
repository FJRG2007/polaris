/**
 * Which language the extension speaks right now: the connected account's, as
 * its server last said, or the browser's.
 *
 * Only the entrypoints import this - it reads browser storage - and nothing here
 * listens for anything on import: a top-level listener in the worker's import
 * graph is one `wxt build` runs, against a fake browser that does not implement
 * them all.
 */

import { storage } from "#imports";
import type { Locale } from "@polaris/core";
import { pickLocale, wordsIn, type Words } from "@/lib/words";

/** The connected account's language, as its server last answered. Null when no
 *  account is connected, or the server did not say. */
export const ACCOUNT_LOCALE = storage.defineItem<string | null>("local:link.locale", { fallback: null });

/** The language to speak right now. */
export async function currentLocale(): Promise<Locale> {
    const stored = await ACCOUNT_LOCALE.getValue().catch(() => null);
    return pickLocale(stored);
}

/** The words to speak right now. */
export async function words(): Promise<Words> {
    return wordsIn(await currentLocale());
}
