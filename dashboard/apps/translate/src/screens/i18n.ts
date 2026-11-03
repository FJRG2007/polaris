/**
 * Translate's words in the browser, in the language the page is drawn in.
 */

import { hostUi } from "@polaris/app-host/client";
import { translateCatalogs } from "../../messages";
import type { TranslateTranslator } from "../lib/i18n";

export function useTranslateT(): TranslateTranslator {
    return translateCatalogs.translator(hostUi.i18nProvider.useLocale(), "translate");
}

export function useTranslateLocale(): string {
    return hostUi.i18nProvider.useLocale();
}

/** An action's `{ ok, error }` answer as a value or a thrown sentence. */
export async function unwrap<T extends { ok: boolean }>(
    call: () => Promise<T>,
    fallback: string
): Promise<Extract<T, { ok: true }>> {
    let failure = fallback;
    const answer = await hostUi.runAction.runAction(call, (message) => {
        failure = message;
    });
    if (!answer) throw new Error(failure);
    if (!answer.ok) throw new Error((answer as unknown as { error: string }).error);
    return answer as Extract<T, { ok: true }>;
}

/** Reads what the last visit kept, or null. Never throws. */
export function readCache<T>(key: string): T | null {
    try {
        const raw = sessionStorage.getItem(`translate:${key}`);
        return raw ? (JSON.parse(raw) as T) : null;
    } catch {
        return null;
    }
}

export function writeCache(key: string, value: unknown): void {
    try {
        sessionStorage.setItem(`translate:${key}`, JSON.stringify(value));
    } catch {
        // Private windows and full storage: the next visit asks the server.
    }
}
