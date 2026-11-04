/**
 * The decisions behind translating text outside the Translate app - the
 * selection menu, a chat message's menu and live chat translation - kept pure
 * so they can be asserted without a browser or an engine.
 */

import type { ChatTranslationPrefs } from "@polaris/core";

/** The languages a reader can pick as a target. The Translate app's own list;
 *  core holds its copy because it never imports the app. */
export const TARGET_LANGUAGES = [
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

/** The most texts one request carries - the Translate route's own ceiling. */
export const BATCH_TEXTS = 50;

/** What one batch may weigh when the administrator set no length limit: the
 *  route's own ceiling on a request. */
export const BATCH_CHARS = 50_000;

/** The language of a locale, as a target: `es-ES` is `es`, Chinese keeps its
 *  script, and Brazil keeps its Portuguese. */
export function localeLanguage(locale: string): string {
    const [base = "en", region = ""] = locale.split("-");
    const lower = base.toLowerCase();
    if (lower === "zh") return /^(TW|HK|MO|Hant)$/i.test(region) ? "zh-Hant" : "zh-Hans";
    if (lower === "pt" && region.toUpperCase() === "BR") return "pt-BR";
    return (TARGET_LANGUAGES as readonly string[]).includes(lower) ? lower : "en";
}

/** Whether two language codes name the same language, script and region aside
 *  - except Chinese, where the script is the language a reader reads. */
export function sameLanguage(one: string | null, other: string | null): boolean {
    if (!one || !other) return false;
    const a = one.toLowerCase();
    const b = other.toLowerCase();
    if (a.startsWith("zh") || b.startsWith("zh")) return a === b || a === "zh" || b === "zh";
    return a.split("-")[0] === b.split("-")[0];
}

/** Text compared the way a reader would: case, spacing and punctuation aside. */
function comparable(text: string): string {
    return text
        .normalize("NFKC")
        .toLowerCase()
        .replace(/[\p{P}\p{S}]+/gu, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** Whether an engine handed the words back unchanged, which is what it does
 *  with text already in the language it was asked for. */
export function unchanged(original: string, translated: string): boolean {
    return comparable(original) === comparable(translated);
}

/**
 * The texts cut into requests: at most `BATCH_TEXTS` each, and no heavier than
 * the administrator's length limit. A text that is over the limit on its own
 * is answered `tooLong` and never sent. Positions are into `texts`.
 */
export function planBatches(
    texts: readonly string[],
    charLimit: number | null
): { batches: number[][]; tooLong: number[] } {
    const ceiling = Math.min(charLimit ?? BATCH_CHARS, BATCH_CHARS);
    const batches: number[][] = [];
    const tooLong: number[] = [];
    let current: number[] = [];
    let weight = 0;
    texts.forEach((text, at) => {
        if (text.length > ceiling) {
            tooLong.push(at);
            return;
        }
        if (current.length === BATCH_TEXTS || weight + text.length > ceiling) {
            batches.push(current);
            current = [];
            weight = 0;
        }
        current.push(at);
        weight += text.length;
    });
    if (current.length > 0) batches.push(current);
    return { batches, tooLong };
}

/** A message as live translation needs to know it. */
export interface TranslatableMessage {
    readonly id: string;
    readonly authorId: string | null;
    readonly kind: string;
    readonly body: string;
    readonly deleted?: boolean;
    /** Sent translated by its author into this language. */
    readonly translated?: { readonly to: string } | null;
}

/**
 * Whether a message on screen is one live translation turns into the reader's
 * language: their choice is on, somebody else wrote it (your own words come
 * back to you as you wrote them), it is words rather than a notice or a
 * tombstone, and it was not already sent in that language.
 */
export function translatesIncoming(
    message: TranslatableMessage,
    viewerId: string,
    prefs: ChatTranslationPrefs,
    target: string
): boolean {
    if (!prefs.incoming) return false;
    if (message.authorId === viewerId) return false;
    if (message.deleted || message.id.startsWith("pending:")) return false;
    if (message.kind !== "text" && message.kind !== "poll") return false;
    if (!message.body.trim()) return false;
    if (message.translated && sameLanguage(message.translated.to, target)) return false;
    return true;
}

/**
 * The language what the reader types goes out in, or null when it goes as
 * written: their choice is off, or they are correcting a message already sent
 * (an edit keeps the words they choose, in the language they choose).
 */
export function outgoingTarget(prefs: ChatTranslationPrefs, editing: boolean): string | null {
    if (editing) return null;
    return prefs.outgoing;
}

/**
 * Translations already made, by target language and words, so a message seen
 * twice - scrolled past and back, or open in a thread too - costs one request.
 * Bounded twice: at most `max` entries, oldest out first, and each one ends
 * after `ttlMs`, since an engine or the words of a message can change.
 */
export class TranslationCache<T> {
    private readonly entries = new Map<string, { value: T; until: number }>();

    constructor(
        private readonly max = 500,
        private readonly ttlMs = 30 * 60_000,
        private readonly now: () => number = Date.now
    ) {}

    private static key(to: string, text: string): string {
        return `${to}\u0000${text}`;
    }

    get(to: string, text: string): T | undefined {
        const key = TranslationCache.key(to, text);
        const entry = this.entries.get(key);
        if (!entry) return undefined;
        if (entry.until <= this.now()) {
            this.entries.delete(key);
            return undefined;
        }
        // Read again is used again: to the back of the line.
        this.entries.delete(key);
        this.entries.set(key, entry);
        return entry.value;
    }

    set(to: string, text: string, value: T): void {
        const key = TranslationCache.key(to, text);
        this.entries.delete(key);
        this.entries.set(key, { value, until: this.now() + this.ttlMs });
        while (this.entries.size > this.max) {
            const oldest = this.entries.keys().next().value;
            if (oldest === undefined) break;
            this.entries.delete(oldest);
        }
    }

    get size(): number {
        return this.entries.size;
    }
}
