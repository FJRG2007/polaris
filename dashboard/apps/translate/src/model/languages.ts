/**
 * The languages Translate offers, as short BCP 47 codes. Their names are not
 * in the catalogs: `Intl.DisplayNames` says each one in the reader's language,
 * which is what the browser's own pickers do.
 *
 * The set is the one the engines broadly share (DeepL's list is the shortest
 * of the paid ones); an engine that cannot do a pair says so when asked.
 */

export const LANGUAGE_CODES = [
    "ar",
    "bg",
    "ca",
    "cs",
    "da",
    "de",
    "el",
    "en",
    "es",
    "et",
    "eu",
    "fi",
    "fr",
    "gl",
    "he",
    "hi",
    "hu",
    "id",
    "it",
    "ja",
    "ko",
    "lt",
    "lv",
    "nb",
    "nl",
    "pl",
    "pt",
    "pt-BR",
    "ro",
    "ru",
    "sk",
    "sl",
    "sv",
    "th",
    "tr",
    "uk",
    "vi",
    "zh-Hans",
    "zh-Hant"
] as const;

export type LanguageCode = (typeof LANGUAGE_CODES)[number];

/** A source that is not a language: the engine works it out. */
export const AUTO = "auto";

export type SourceLanguage = LanguageCode | typeof AUTO;

const KNOWN: ReadonlySet<string> = new Set(LANGUAGE_CODES);

export function isLanguageCode(value: unknown): value is LanguageCode {
    return typeof value === "string" && KNOWN.has(value);
}

/**
 * A code an engine detected (`EN`, `pt-br`, `zh-CN`, `iw`) as one of ours, or
 * null when it is not a language Translate offers.
 */
export function normalizeDetected(raw: string | null | undefined): LanguageCode | null {
    if (!raw) return null;
    const lower = raw.trim().toLowerCase();
    if (lower === "zh" || lower === "zh-cn" || lower === "zh-hans") return "zh-Hans";
    if (lower === "zh-tw" || lower === "zh-hk" || lower === "zh-hant") return "zh-Hant";
    if (lower === "pt-br") return "pt-BR";
    if (lower === "iw") return "he";
    if (lower === "no" || lower === "nn") return "nb";
    if (isLanguageCode(lower)) return lower;
    const base = lower.split("-")[0];
    return isLanguageCode(base) ? base : null;
}

/** A language's name in `locale`, or its code when the runtime has no name for it. */
export function languageName(code: string, locale: string): string {
    try {
        return new Intl.DisplayNames([locale], { type: "language" }).of(code) ?? code;
    } catch {
        return code;
    }
}
