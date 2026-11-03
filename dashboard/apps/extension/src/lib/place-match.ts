/**
 * Which option of a page's country or region dropdown is the one an identity
 * holds, and what to type into a country box that is plain text.
 *
 * The vault stores a country as its ISO 3166-1 alpha-2 code (`ES`), but older
 * identities hold whatever somebody typed, in whatever language: "España",
 * "Spain", "Espagne", "USA". A page's dropdown is just as free: its values may
 * be codes, numbers or names, and its text is in the page's language. So both
 * sides are resolved to a code and compared there, with the names the browser's
 * own `Intl.DisplayNames` gives for every code - nothing here ships a list of
 * country names that could go stale or miss a language.
 *
 * Pure, and taking plain option descriptions rather than elements, so the rules
 * can be asserted without a DOM.
 */

// The subpath rather than the package: `@polaris/core` is a barrel over the
// whole domain, and the content script only needs the code list.
import { COUNTRY_CODES } from "@polaris/core/geo";

/** One `<option>` of a dropdown, as the rules read it. */
export interface PlaceOption {
    readonly value: string;
    readonly text: string;
    readonly disabled?: boolean;
}

/** Languages tried after the page's and the browser's own: the two this
 *  product is written in, and the next few an old identity is most likely to
 *  have been typed in. Each costs one `Intl.DisplayNames` pass over the codes,
 *  done once and kept. */
const ALWAYS = ["en", "es", "fr", "de", "it", "pt"] as const;

/** Spellings `Intl.DisplayNames` never produces but people write, normalized. */
const ALIASES: Readonly<Record<string, string>> = {
    usa: "US",
    "u s a": "US",
    "u s": "US",
    eeuu: "US",
    "ee uu": "US",
    "united states of america": "US",
    "estados unidos de america": "US",
    uk: "GB",
    "u k": "GB",
    "great britain": "GB",
    britain: "GB",
    "gran bretana": "GB",
    uae: "AE",
    eau: "AE",
    holland: "NL",
    "the netherlands": "NL",
    "czech republic": "CZ",
    "republica checa": "CZ",
    turkey: "TR",
    "korea south": "KR",
    "south korea": "KR",
    "corea del sur": "KR"
};

/** Option text that is the dropdown asking rather than an answer. */
const PLACEHOLDER =
    /^(?:select|choose|pick|please|seleccion|selecciona|seleccione|elige|elija|escoge|choisi|s[eé]lection|w[aä]hlen|bitte|scegli|none|ninguno|-+)/;

const KNOWN = new Set(COUNTRY_CODES);

/**
 * A place name reduced to what two spellings of it share: decomposed and
 * stripped of accents, lowercased, punctuation turned into spaces, spaces
 * collapsed. "Côte d'Ivoire" and "cote d ivoire" are the same here.
 */
export function normalizePlace(raw: string): string {
    return raw
        .normalize("NFD")
        .replace(/\p{M}+/gu, "")
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** The languages to read names in, best first and each once: the page's, the
 *  browser's, then `ALWAYS`. A tag `Intl` refuses is left out. */
export function placeLocales(
    pageLang: string | null | undefined,
    browserLangs: readonly string[] = []
): string[] {
    const out: string[] = [];
    for (const tag of [pageLang ?? "", ...browserLangs, ...ALWAYS]) {
        const clean = tag.trim().replace(/_/g, "-");
        if (clean === "") continue;
        let canonical: string;
        try {
            canonical = Intl.getCanonicalLocales(clean)[0] ?? "";
        } catch {
            continue;
        }
        if (canonical !== "" && !out.includes(canonical)) out.push(canonical);
    }
    return out;
}

/** Every code's normalized name in one language, built once per language. */
const indexes = new Map<string, ReadonlyMap<string, string>>();

function indexFor(locale: string): ReadonlyMap<string, string> {
    const held = indexes.get(locale);
    if (held) return held;
    const index = new Map<string, string>();
    try {
        const names = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
        for (const code of COUNTRY_CODES) {
            const name = names.of(code);
            if (name) index.set(normalizePlace(name), code);
        }
    } catch {
        // A runtime without region names resolves codes and aliases only.
    }
    indexes.set(locale, index);
    return index;
}

/**
 * The alpha-2 code a stored or shown country stands for, or null when nothing
 * resolves it. A two-letter code is taken as one; anything else is looked up
 * by name in each of `locales`, then among the aliases.
 */
export function countryCode(raw: string, locales: readonly string[]): string | null {
    const trimmed = raw.trim();
    if (/^[A-Za-z]{2}$/.test(trimmed)) {
        const upper = trimmed.toUpperCase();
        // `UK` is what people write for `GB`, and is no code of its own.
        if (KNOWN.has(upper)) return upper;
    }
    const name = normalizePlace(trimmed);
    if (name === "") return null;
    for (const locale of locales) {
        const code = indexFor(locale).get(name);
        if (code) return code;
    }
    return ALIASES[name] ?? null;
}

/** The country's name in `locale`, for a box that takes text. Null when the
 *  runtime has no name for it. */
export function countryNameIn(code: string, locale: string): string | null {
    try {
        const names = new Intl.DisplayNames([locale], { type: "region", fallback: "none" });
        return names.of(code) ?? null;
    } catch {
        return null;
    }
}

/**
 * What to type into a country box that takes text: the country's name in the
 * page's language when the stored value resolves, the stored value as written
 * when it does not.
 */
export function countryText(stored: string, locales: readonly string[]): string {
    const code = countryCode(stored, locales);
    const name = code === null ? null : countryNameIn(code, locales[0] ?? "en");
    return name ?? stored.trim();
}

/** Whether an option is the dropdown's prompt rather than a choice. */
export function isPlaceholder(option: PlaceOption): boolean {
    if (option.disabled) return true;
    if (option.value.trim() === "") return true;
    const text = normalizePlace(option.text);
    return text === "" || PLACEHOLDER.test(text);
}

/**
 * The index of the option in a country dropdown that is `stored`, or -1.
 *
 * The values are tried first, because a value that is a code is the page
 * saying what it means; then the text, in any of `locales`. An alpha-3 value
 * (`ESP`) is not resolvable without a table of them, so such a dropdown is
 * matched by its text.
 */
export function pickCountry(
    options: readonly PlaceOption[],
    stored: string,
    locales: readonly string[]
): number {
    const code = countryCode(stored, locales);
    if (code === null) return -1;
    const real = options
        .map((option, index) => ({ option, index }))
        .filter(({ option }) => !isPlaceholder(option));
    const byValue = real.find(({ option }) => countryCode(option.value, locales) === code);
    if (byValue) return byValue.index;
    const byText = real.find(({ option }) => countryCode(option.text, locales) === code);
    return byText ? byText.index : -1;
}

/** Whether every word of `part` appears, in order and whole, in `whole`. */
function containsWords(whole: string, part: string): boolean {
    return ` ${whole} `.includes(` ${part} `);
}

/**
 * The index of the option in a region dropdown that is `stored`, or -1.
 *
 * Equality first, on the text or the value - which is also how a stored code
 * like `CA` or `MAD` meets a dropdown whose values are codes. Then whole-word
 * containment either way, so "Madrid" finds "Comunidad de Madrid" and
 * "Comunidad de Madrid" finds "Madrid"; where several contain it, the one
 * closest in length wins. A placeholder is never picked.
 */
export function pickRegion(options: readonly PlaceOption[], stored: string): number {
    const wanted = normalizePlace(stored);
    if (wanted === "") return -1;
    const real = options
        .map((option, index) => ({
            index,
            text: normalizePlace(option.text),
            value: normalizePlace(option.value),
            placeholder: isPlaceholder(option)
        }))
        .filter((option) => !option.placeholder);

    const equal = real.find((option) => option.text === wanted || option.value === wanted);
    if (equal) return equal.index;

    let best = -1;
    let gap = Number.POSITIVE_INFINITY;
    for (const option of real) {
        if (option.text === "") continue;
        if (!containsWords(option.text, wanted) && !containsWords(wanted, option.text)) continue;
        const distance = Math.abs(option.text.length - wanted.length);
        if (distance < gap) {
            gap = distance;
            best = option.index;
        }
    }
    return best;
}
