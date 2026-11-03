/**
 * The browser's own translator: Chrome's Translator and LanguageDetector APIs
 * (developer.chrome.com/docs/ai/translator-api,
 * developer.chrome.com/docs/ai/language-detection). Desktop Chrome only; in
 * any other browser `Translator` is not on `self` and this engine is simply
 * not offered.
 *
 * The shape used: `Translator.availability({ sourceLanguage, targetLanguage })`
 * resolves to "unavailable", "downloadable", "downloading" or "available";
 * `Translator.create({ sourceLanguage, targetLanguage, monitor })` resolves to a
 * translator whose `translate(text)` resolves to the translated string; the
 * monitor's `downloadprogress` events carry `loaded` as a fraction.
 * `LanguageDetector.create()` resolves to a detector whose `detect(text)`
 * resolves to `{ detectedLanguage, confidence }[]`, most likely first.
 * `create()` may need a user gesture the first time a model downloads, which
 * typing is.
 *
 * Nothing here leaves the device.
 */

import type { EngineResult, TranslateEngine } from "../model/engines";

type Availability = "unavailable" | "downloadable" | "downloading" | "available";

interface DownloadMonitor {
    addEventListener(type: "downloadprogress", listener: (event: { loaded: number }) => void): void;
}

interface BrowserTranslator {
    translate(text: string, options?: { signal?: AbortSignal }): Promise<string>;
    destroy?(): void;
}

interface TranslatorApi {
    availability(options: { sourceLanguage: string; targetLanguage: string }): Promise<Availability>;
    create(options: {
        sourceLanguage: string;
        targetLanguage: string;
        signal?: AbortSignal;
        monitor?: (monitor: DownloadMonitor) => void;
    }): Promise<BrowserTranslator>;
}

interface BrowserDetector {
    detect(
        text: string,
        options?: { signal?: AbortSignal }
    ): Promise<{ detectedLanguage: string; confidence: number }[]>;
}

interface DetectorApi {
    create(options?: {
        signal?: AbortSignal;
        monitor?: (monitor: DownloadMonitor) => void;
    }): Promise<BrowserDetector>;
}

/** Where the APIs live: `self` in a page, a stand-in in a test. */
export type BrowserScope = Record<string, unknown>;

function translatorApi(scope: BrowserScope): TranslatorApi | null {
    const api = scope.Translator as Partial<TranslatorApi> | undefined;
    return api && typeof api.create === "function" && typeof api.availability === "function"
        ? (api as TranslatorApi)
        : null;
}

function detectorApi(scope: BrowserScope): DetectorApi | null {
    const api = scope.LanguageDetector as Partial<DetectorApi> | undefined;
    return api && typeof api.create === "function" ? (api as DetectorApi) : null;
}

/** Whether this browser has a built-in translator at all. */
export function hasBrowserTranslator(scope: BrowserScope | undefined): boolean {
    return scope !== undefined && translatorApi(scope) !== null;
}

/** The browser's spelling of one of our codes: Simplified Chinese is plain `zh`. */
export function browserCode(code: string): string {
    return code === "zh-Hans" ? "zh" : code;
}

/** Thrown when the browser cannot do what was asked; the screen moves on. */
export class BrowserEngineUnavailable extends Error {
    public constructor(reason: string) {
        super(reason);
        this.name = "BrowserEngineUnavailable";
    }
}

/**
 * The browser engine over `scope`. Translators are kept per language pair, so
 * a model is created once and every later keystroke reuses it.
 * `onProgress` hears a download's progress, 0 to 1.
 */
export function createBrowserEngine(
    scope: BrowserScope,
    onProgress?: (loaded: number) => void
): TranslateEngine {
    const translators = new Map<string, Promise<BrowserTranslator>>();
    let detector: Promise<BrowserDetector> | null = null;
    const monitor = (target: DownloadMonitor) =>
        target.addEventListener("downloadprogress", (event) => onProgress?.(event.loaded));

    const detect = async (text: string, signal?: AbortSignal): Promise<string | null> => {
        const api = detectorApi(scope);
        if (!api) throw new BrowserEngineUnavailable("no detector");
        detector ??= api.create({ monitor }).catch((caught: unknown) => {
            detector = null;
            throw caught;
        });
        const ranked = await (await detector).detect(text, { signal });
        const top = ranked.find((entry) => entry.detectedLanguage !== "und");
        return top?.detectedLanguage ?? null;
    };

    const translatorFor = async (from: string, to: string): Promise<BrowserTranslator> => {
        const api = translatorApi(scope);
        if (!api) throw new BrowserEngineUnavailable("no translator");
        const pair = { sourceLanguage: browserCode(from), targetLanguage: browserCode(to) };
        const key = `${pair.sourceLanguage}>${pair.targetLanguage}`;
        let made = translators.get(key);
        if (!made) {
            if ((await api.availability(pair)) === "unavailable") {
                throw new BrowserEngineUnavailable("pair");
            }
            made = api.create({ ...pair, monitor });
            translators.set(key, made);
            made.catch(() => translators.delete(key));
        }
        return made;
    };

    return {
        id: "browser",
        detect,
        async translate(texts, from, to, signal): Promise<EngineResult> {
            const source = from ?? (await detect(texts.join("\n").slice(0, 1000), signal));
            if (!source) throw new BrowserEngineUnavailable("undetected");
            if (browserCode(source) === browserCode(to)) {
                return { texts: [...texts], detected: from ? null : source };
            }
            const translator = await translatorFor(source, to);
            const out: string[] = [];
            // One at a time: the browser runs them in order anyway.
            for (const text of texts) {
                signal?.throwIfAborted();
                out.push(text.trim() ? await translator.translate(text, { signal }) : text);
            }
            return { texts: out, detected: from ? null : source };
        }
    };
}
