/**
 * The local engine as a page runs it: the Bergamot worker, model files from
 * Polaris kept in Cache Storage, and the language read by the browser's own
 * detector where there is one (Chrome), otherwise by Polaris.
 */

import { detectOnServer } from "./server-engine";
import type { TranslateEngine } from "../model/engines";
import { createBrowserEngine, type BrowserScope } from "./browser-engine";
import { bergamotWorker, cachedModelFiles, createLocalEngine } from "./local-engine";

/**
 * `downloadFailed` is said when a model cannot be fetched and Polaris gave no
 * reason; `failed` when detection fails the same way.
 */
export function deviceEngine(
    downloadFailed: string,
    failed: string,
    onProgress?: (loaded: number) => void
): TranslateEngine {
    const browser = createBrowserEngine(self as unknown as BrowserScope);
    return createLocalEngine({
        makeWorker: bergamotWorker,
        loadFile: cachedModelFiles(downloadFailed),
        onProgress,
        detect: async (text, signal) => {
            try {
                const read = await browser.detect(text, signal);
                if (read) return read;
            } catch {
                // No detector in this browser: Polaris reads it instead.
            }
            return detectOnServer(text, failed, signal);
        }
    });
}
