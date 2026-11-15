/**
 * The language this reader last translated into, remembered on this device so
 * the next translation starts there instead of in the language Polaris is read
 * in. Shared with the core screens' translator under the same key
 * (`apps/web/src/components/text-translation/provider.tsx`), so a language
 * picked in either is the one both open with.
 */

import { isLanguageCode, type LanguageCode } from "../model/languages";

const KEY = "polaris:translate-to";

export function readLastTarget(): LanguageCode | null {
    try {
        const stored = localStorage.getItem(KEY);
        return isLanguageCode(stored) ? stored : null;
    } catch {
        return null;
    }
}

export function writeLastTarget(code: string): void {
    try {
        localStorage.setItem(KEY, code);
    } catch {
        // Private windows and blocked storage: the reader's language is the default again.
    }
}
