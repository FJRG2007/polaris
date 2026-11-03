/**
 * The on-screen keyboard's layouts and the two pieces of typing it does by
 * itself: putting a key's text at the caret of an input the way a real key
 * press would (so React sees it), and composing Korean jamo into syllables
 * as the standard two-set (Dubeolsik) keyboard does.
 *
 * The layouts are Polaris's own, following the letter positions of each
 * script's national layout (ЙЦУКЕН, the Greek and Hebrew standard layouts,
 * Arabic 101, InScript, Dubeolsik) and the kana table; no third-party layout
 * data is copied.
 *
 * Pure apart from `insertAt` and `deleteBefore`, which touch the field.
 */

export const KEYBOARD_LAYOUTS = [
    "latin",
    "cyrillic",
    "greek",
    "arabic",
    "hebrew",
    "devanagari",
    "kana",
    "hangul"
] as const;
export type KeyboardLayoutId = (typeof KEYBOARD_LAYOUTS)[number];

/** Rows of keys; a key is usually one character, sometimes a few ("لا", "क्ष"). */
export type KeyRows = readonly (readonly string[])[];

export interface KeyboardLayout {
    base: KeyRows;
    shift: KeyRows;
    /** Symbols, marks and the less common letters. */
    alt: KeyRows;
}

const rows = (...lines: string[]): KeyRows => lines.map((line) => line.split(" "));

/** Each key of `layer` changed by `change`. */
const mapRows = (layer: KeyRows, change: (key: string) => string): KeyRows =>
    layer.map((row) => row.map(change));

const upper = (key: string) => (key === "ß" ? "ẞ" : key.toLocaleUpperCase());

/** Hiragana to katakana: the same table, 0x60 code points on. */
const katakana = (key: string) =>
    Array.from(key)
        .map((char) => {
            const code = char.codePointAt(0)!;
            return code >= 0x3041 && code <= 0x3096 ? String.fromCodePoint(code + 0x60) : char;
        })
        .join("");

const latinBase = rows("à á â ä ã å æ ç è é", "ê ë ì í î ï ñ ò ó ô", "ö õ ø œ ß ù ú û ü ý");

const kanaBase = rows(
    "あ い う え お か き く け こ",
    "さ し す せ そ た ち つ て と",
    "な に ぬ ね の は ひ ふ へ ほ",
    "ま み む め も や ゆ よ ら り",
    "る れ ろ わ を ん ー 、 。 ・"
);
const kanaAlt = rows(
    "が ぎ ぐ げ ご ざ じ ず ぜ ぞ",
    "だ ぢ づ で ど ば び ぶ べ ぼ",
    "ぱ ぴ ぷ ぺ ぽ ぁ ぃ ぅ ぇ ぉ",
    "っ ゃ ゅ ょ ゎ ゔ 「 」 ？ ！"
);

const cyrillicBase = rows(
    "й ц у к е н г ш щ з х ъ",
    "ф ы в а п р о л д ж э",
    "я ч с м и т ь б ю ё"
);

const greekBase = rows("ς ε ρ τ υ θ ι ο π", "α σ δ φ γ η ξ κ λ", "ζ χ ψ ω β ν μ");

export const LAYOUTS: Record<KeyboardLayoutId, KeyboardLayout> = {
    latin: {
        base: latinBase,
        shift: mapRows(latinBase, upper),
        alt: rows("¿ ¡ « » € £ ¥ ¢ © ®", "° ± × ÷ ¼ ½ ¾ ‰ µ §", "‘ ’ “ ” „ … • ¶ ¬ ¤")
    },
    cyrillic: {
        base: cyrillicBase,
        shift: mapRows(cyrillicBase, upper),
        // Ukrainian, Belarusian, Serbian and Macedonian letters, and the quotes.
        alt: rows("і ї є ґ ў ђ ј љ њ ћ џ", "І Ї Є Ґ Ў Ђ Ј Љ Њ Ћ Џ", "« » „ “ № ₽ ₴")
    },
    greek: {
        base: greekBase,
        shift: mapRows(greekBase, (key) => (key === "ς" ? "Σ" : key.toLocaleUpperCase())),
        alt: rows("ά έ ή ί ό ύ ώ ϊ ϋ", "Ά Έ Ή Ί Ό Ύ Ώ Ϊ Ϋ", "ΐ ΰ ; · « »")
    },
    arabic: {
        base: rows("ض ص ث ق ف غ ع ه خ ح ج د", "ش س ي ب ل ا ت ن م ك ط", "ئ ء ؤ ر لا ى ة و ز ظ"),
        shift: rows("َ ً ُ ٌ لإ إ ÷ × ؛ ـ", "ِ ٍ لأ أ ، / : ْ ّ", "لآ آ ؟ . « »"),
        alt: rows("٠ ١ ٢ ٣ ٤ ٥ ٦ ٧ ٨ ٩", "پ چ ژ گ ک ی ٹ ڈ ڑ ں", "ہ ے ٪ ٫ ٬")
    },
    hebrew: {
        base: rows("ק ר א ט ו ן ם פ", "ש ד ג כ ע י ח ל ך ף", "ז ס ב ה נ מ צ ת ץ"),
        // The vowel points, typed after the letter they sit on.
        shift: rows("ְ ֱ ֲ ֳ ִ ֵ ֶ", "ַ ָ ֹ ֻ ּ ׁ ׂ", "׳ ״ ־ ₪"),
        alt: rows("װ ױ ײ ׆", "„ ” « »")
    },
    devanagari: {
        base: rows("ौ ै ा ी ू ब ह ग द ज ड ़", "ो े ् ि ु प र क त च ट", "ॉ ं म न व ल स , . य"),
        shift: rows("औ ऐ आ ई ऊ भ ङ घ ध झ ढ ञ", "ओ ए अ इ उ फ ऱ ख थ छ ठ", "ऑ ँ ण ऩ ऴ ळ श ष । य़"),
        alt: rows("० १ २ ३ ४ ५ ६ ७ ८ ९", "ऋ ृ ॠ ॄ ः ॐ ॥ ₹", "क्ष त्र ज्ञ श्र")
    },
    kana: {
        base: kanaBase,
        shift: mapRows(kanaBase, katakana),
        alt: kanaAlt
    },
    hangul: {
        base: rows(
            "ㅂ ㅈ ㄷ ㄱ ㅅ ㅛ ㅕ ㅑ ㅐ ㅔ",
            "ㅁ ㄴ ㅇ ㄹ ㅎ ㅗ ㅓ ㅏ ㅣ",
            "ㅋ ㅌ ㅊ ㅍ ㅠ ㅜ ㅡ"
        ),
        shift: rows(
            "ㅃ ㅉ ㄸ ㄲ ㅆ ㅛ ㅕ ㅑ ㅒ ㅖ",
            "ㅁ ㄴ ㅇ ㄹ ㅎ ㅗ ㅓ ㅏ ㅣ",
            "ㅋ ㅌ ㅊ ㅍ ㅠ ㅜ ㅡ"
        ),
        alt: rows("ㄳ ㄵ ㄶ ㄺ ㄻ ㄼ ㄽ ㄾ ㄿ ㅀ ㅄ", "ㅘ ㅙ ㅚ ㅝ ㅞ ㅟ ㅢ", "· 〈 〉 《 》 ₩")
    }
};

/** The layout a language is written with; accented Latin for the rest. */
export function layoutForLanguage(code: string | null | undefined): KeyboardLayoutId {
    const base = (code ?? "").toLowerCase().split("-")[0];
    switch (base) {
        case "ar":
        case "fa":
        case "ur":
        case "ps":
            return "arabic";
        case "he":
        case "iw":
        case "yi":
            return "hebrew";
        case "ru":
        case "uk":
        case "be":
        case "bg":
        case "sr":
        case "mk":
        case "kk":
        case "ky":
        case "mn":
        case "tg":
            return "cyrillic";
        case "el":
            return "greek";
        case "hi":
        case "mr":
        case "ne":
        case "sa":
            return "devanagari";
        case "ja":
            return "kana";
        case "ko":
            return "hangul";
        default:
            return "latin";
    }
}

// Korean syllables: 19 leads x 21 vowels x 28 tails (the first "no tail"),
// laid out from U+AC00 (Unicode, chapter 3.12).
const LEADS = Array.from("ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ");
const VOWELS = Array.from("ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ");
const TAILS = ["", ...Array.from("ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ")];
const VOWEL_PAIRS: Record<string, string> = {
    ㅗㅏ: "ㅘ",
    ㅗㅐ: "ㅙ",
    ㅗㅣ: "ㅚ",
    ㅜㅓ: "ㅝ",
    ㅜㅔ: "ㅞ",
    ㅜㅣ: "ㅟ",
    ㅡㅣ: "ㅢ"
};
const TAIL_PAIRS: Record<string, string> = {
    ㄱㅅ: "ㄳ",
    ㄴㅈ: "ㄵ",
    ㄴㅎ: "ㄶ",
    ㄹㄱ: "ㄺ",
    ㄹㅁ: "ㄻ",
    ㄹㅂ: "ㄼ",
    ㄹㅅ: "ㄽ",
    ㄹㅌ: "ㄾ",
    ㄹㅍ: "ㄿ",
    ㄹㅎ: "ㅀ",
    ㅂㅅ: "ㅄ"
};
const SYLLABLE_FIRST = 0xac00;
const SYLLABLE_COUNT = 11172;

const syllable = (lead: number, vowel: number, tail: number) =>
    String.fromCharCode(SYLLABLE_FIRST + (lead * 21 + vowel) * 28 + tail);

function parse(char: string): { lead: number; vowel: number; tail: number } | null {
    const index = char.length === 1 ? char.charCodeAt(0) - SYLLABLE_FIRST : -1;
    if (index < 0 || index >= SYLLABLE_COUNT) return null;
    return {
        lead: Math.floor(index / 588),
        vowel: Math.floor((index % 588) / 28),
        tail: index % 28
    };
}

/** The two halves of a compound, or null when `jamo` is not one. */
function split(pairs: Record<string, string>, jamo: string): [string, string] | null {
    const found = Object.entries(pairs).find(([, value]) => value === jamo);
    return found ? [found[0][0]!, found[0][1]!] : null;
}

export function isJamo(key: string): boolean {
    return LEADS.includes(key) || VOWELS.includes(key) || TAILS.includes(key);
}

/**
 * What `before` (the character before the caret) becomes once `jamo` is
 * typed after it: one syllable grown, a tail moved onto a new syllable, or
 * both side by side when they do not combine.
 */
export function composeHangul(before: string, jamo: string): string {
    const held = parse(before);
    if (!VOWELS.includes(jamo)) {
        if (held && held.tail === 0) {
            const tail = TAILS.indexOf(jamo);
            if (tail > 0) return syllable(held.lead, held.vowel, tail);
        }
        if (held && held.tail > 0) {
            const pair = TAIL_PAIRS[TAILS[held.tail]! + jamo];
            if (pair) return syllable(held.lead, held.vowel, TAILS.indexOf(pair));
        }
        return before + jamo;
    }
    const vowel = VOWELS.indexOf(jamo);
    if (LEADS.includes(before)) return syllable(LEADS.indexOf(before), vowel, 0);
    if (held && held.tail === 0) {
        const pair = VOWEL_PAIRS[VOWELS[held.vowel]! + jamo];
        if (pair) return syllable(held.lead, VOWELS.indexOf(pair), 0);
    }
    if (held && held.tail > 0) {
        // The tail starts the next syllable: 각 + ㅏ is 가가, 값 + ㅏ is 갑사.
        const tail = TAILS[held.tail]!;
        const halves = split(TAIL_PAIRS, tail);
        if (halves) {
            return (
                syllable(held.lead, held.vowel, TAILS.indexOf(halves[0])) +
                syllable(LEADS.indexOf(halves[1]), vowel, 0)
            );
        }
        if (LEADS.includes(tail)) {
            return syllable(held.lead, held.vowel, 0) + syllable(LEADS.indexOf(tail), vowel, 0);
        }
    }
    if (VOWELS.includes(before) && VOWEL_PAIRS[before + jamo]) return VOWEL_PAIRS[before + jamo]!;
    return before + jamo;
}

/** `char` with the last jamo typed taken off, as Backspace does while composing. */
export function backspaceHangul(char: string): string {
    const held = parse(char);
    if (held) {
        if (held.tail > 0) {
            const halves = split(TAIL_PAIRS, TAILS[held.tail]!);
            return syllable(held.lead, held.vowel, halves ? TAILS.indexOf(halves[0]) : 0);
        }
        const halves = split(VOWEL_PAIRS, VOWELS[held.vowel]!);
        return halves ? syllable(held.lead, VOWELS.indexOf(halves[0]), 0) : LEADS[held.lead]!;
    }
    return split(VOWEL_PAIRS, char)?.[0] ?? "";
}

export type TextField = HTMLInputElement | HTMLTextAreaElement;

/** The value set the way the browser's own typing sets it, so React's onChange fires. */
function setValue(field: TextField, value: string, caret: number): void {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value")?.set;
    if (setter) setter.call(field, value);
    else field.value = value;
    field.setSelectionRange(caret, caret);
    field.dispatchEvent(new Event("input", { bubbles: true }));
}

/**
 * `text` typed at the caret of `field`, over any selection, replacing the
 * `replace` characters before the caret first (a syllable being composed).
 * Nothing happens when the field is read-only or it would pass its maxLength.
 * Returns the caret after the insertion, or null when nothing was typed.
 */
export function insertAt(field: TextField, text: string, replace = 0): number | null {
    if (field.readOnly || field.disabled) return null;
    const end = field.selectionEnd ?? field.value.length;
    const start = Math.max(0, (field.selectionStart ?? end) - replace);
    const next = field.value.slice(0, start) + text + field.value.slice(end);
    if (field.maxLength > 0 && next.length > field.maxLength && next.length > field.value.length) {
        return null;
    }
    const caret = start + text.length;
    setValue(field, next, caret);
    return caret;
}

/** Backspace: the selection, or the last character (a whole emoji or cluster) before the caret. */
export function deleteBefore(field: TextField): number | null {
    if (field.readOnly || field.disabled) return null;
    const start = field.selectionStart ?? field.value.length;
    const end = field.selectionEnd ?? start;
    if (start !== end) return insertAt(field, "");
    if (start === 0) return null;
    const before = field.value.slice(0, start);
    const segments =
        typeof Intl !== "undefined" && "Segmenter" in Intl
            ? Array.from(new Intl.Segmenter().segment(before), (part) => part.segment)
            : Array.from(before);
    const last = segments[segments.length - 1] ?? "";
    return insertAt(field, "", last.length);
}
