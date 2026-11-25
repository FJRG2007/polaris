/**
 * What a translator says for a key it does not hold, once the app is running
 * for real (BUG-0037).
 *
 * In development and in the tests a missing message is drawn as its key and
 * logged, so it is seen and the catalog tests fail on it. A production build
 * never draws a key: it reads the message from a fallback catalog (the source
 * language's), and when there is none either it draws nothing, and the miss is
 * reported - once per key - so it shows up in the server's log instead of on
 * somebody's screen.
 */

import type { MessageParams, RichParams, Translator } from "@polaris/core";

export const SHOWS_KEYS = process.env.NODE_ENV !== "production";

/**
 * `primary` where it holds the key, else `fallback`, else nothing and `missed`.
 * Unchanged outside production, where the key itself is the loud answer.
 */
export function withFallback<T extends Translator>(
    primary: T,
    fallback: Translator | undefined,
    missed: (key: string) => void
): T {
    if (SHOWS_KEYS) return primary;
    const pick = (key: string): Translator | undefined => {
        if (primary.has(key)) return primary;
        if (fallback?.has(key)) return fallback;
        missed(key);
        return undefined;
    };
    const translate = ((key: string, params?: MessageParams) =>
        pick(key)?.(key, params) ?? "") as T;
    translate.rich = (<R>(key: string, params: RichParams<R>) =>
        pick(key)?.rich(key, params) ?? []) as T["rich"];
    translate.has = ((key: string) => primary.has(key) || !!fallback?.has(key)) as T["has"];
    Object.defineProperty(translate, "locale", { value: primary.locale, enumerable: true });
    return translate;
}

/** Each key logged once, and only so many: a log, not a way to fill one. */
const logged = new Set<string>();

export function logMissingMessage(key: string, where: string): void {
    if (logged.has(key) || logged.size >= 2000) return;
    logged.add(key);
    console.error(`[i18n] No message for "${key}" (${where}); drawn from the source language or left blank`);
}
