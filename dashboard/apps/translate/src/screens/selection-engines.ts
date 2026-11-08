"use client";

/**
 * The engines that run on the reader's device, for the translation the rest
 * of Polaris offers on a selection (see `textTranslation` in
 * `translate-extension.ts`): the browser's own translator and the local one,
 * each only where this browser can run it. The shell tries them in the
 * administrator's order before it asks Polaris.
 */

import type { TranslateEngine } from "../model/engines";
import { deviceEngine } from "./device-engine";
import { canRunLocally } from "./local-engine";
import { createBrowserEngine, hasBrowserTranslator, type BrowserScope } from "./browser-engine";

export interface SelectionEngines {
    readonly browser: TranslateEngine | null;
    readonly local: TranslateEngine | null;
}

/** Made once per shell; `failed` is said when a model or detection fails without a reason. */
export function selectionEngines(failed: string): SelectionEngines {
    const scope = self as unknown as BrowserScope;
    return {
        browser: hasBrowserTranslator(scope) ? createBrowserEngine(scope) : null,
        local: canRunLocally(scope) ? deviceEngine(failed, failed) : null
    };
}
