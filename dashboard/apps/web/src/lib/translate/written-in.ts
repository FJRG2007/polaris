/**
 * The language a text is written in, by its letters alone - no engine, no
 * network. Used to check an answer, not to make one: a language model asked to
 * translate sometimes hands the text back as it was, and on its own word alone
 * that reads as "already in this language".
 *
 * Only languages this detector tells apart reliably are named; for anything
 * else (Catalan next to Spanish, Danish next to Norwegian) it says nothing and
 * the caller keeps whatever it already believed.
 */

import { franc } from "franc-min";
import { sameLanguage, unchanged } from "@/lib/text-translation/logic";

/** Fewer letters than this and a guess is noise. */
export const WRITTEN_IN_MIN = 24;

/** The detector's ISO 639-3 codes, as the translation targets name them. */
const TARGETS: Readonly<Record<string, string>> = {
    arb: "ar",
    bul: "bg",
    ces: "cs",
    deu: "de",
    ell: "el",
    eng: "en",
    spa: "es",
    fra: "fr",
    heb: "he",
    hin: "hi",
    hun: "hu",
    ind: "id",
    ita: "it",
    jpn: "ja",
    kor: "ko",
    nld: "nl",
    pol: "pl",
    por: "pt",
    ron: "ro",
    rus: "ru",
    swe: "sv",
    tha: "th",
    tur: "tr",
    ukr: "uk",
    vie: "vi",
    cmn: "zh"
};

/** Targets the detector can vouch for; for any other a check stands aside. */
export const CHECKABLE: ReadonlySet<string> = new Set(Object.values(TARGETS));

/** The target code `text` is written in, or null when it cannot say. */
export function writtenIn(text: string): string | null {
    if (text.trim().length < WRITTEN_IN_MIN) return null;
    return TARGETS[franc(text, { minLength: WRITTEN_IN_MIN })] ?? null;
}

/** An engine's answer: one text per input, and the source it read. */
export interface CheckedAnswer {
    texts: string[];
    detected: string | null;
}

/**
 * A language model's answer, checked: a text handed back word for word while it
 * is plainly written in another language than the one asked for was not
 * translated, whatever the model says it detected. Taken at its word, that is
 * the reader told "already in this language" about an email they cannot read.
 * The detected language is the letters' own where they can tell, not the
 * model's claim.
 */
export function checkedAnswer(
    texts: readonly string[],
    answer: CheckedAnswer,
    to: string
): CheckedAnswer | null {
    const target = to.toLowerCase().split("-")[0]!;
    for (const [at, text] of texts.entries()) {
        if (!unchanged(text, answer.texts[at] ?? "")) continue;
        const source = CHECKABLE.has(target) ? writtenIn(text) : null;
        if (source && !sameLanguage(source, to)) return null;
    }
    const seen = texts.length === 1 ? writtenIn(texts[0]!) : null;
    return seen ? { ...answer, detected: seen } : answer;
}
