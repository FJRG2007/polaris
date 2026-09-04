/**
 * The characters that have no business being in somebody's name.
 *
 * A name field is not a message box. What ends up in one gets printed beside
 * everything the account does - in a roster, in an audit line, in the subject of
 * an email - and three kinds of character turn that into a problem rather than a
 * preference:
 *
 * - **Invisible ones.** A zero-width space or a soft hyphen makes two accounts
 *   look identical and compare differently, which is impersonation with no
 *   forgery in it. The tag characters (U+E0000..) are worse: they carry a whole
 *   hidden string inside a name that renders as nothing at all.
 * - **Direction overrides.** U+202E reverses everything after it, so a name can
 *   be written to read as somebody else's, or to reverse the line it is printed
 *   in.
 * - **Emoji and pictographs.** Not dangerous, simply not a name: they break
 *   sorting, they are unsearchable, and half the places a name appears - a
 *   monospace log, a plain-text mail - cannot draw them.
 *
 * What is deliberately allowed is anything a real name is written with. Every
 * script, every accent, apostrophes and hyphens, and the two joiners Persian and
 * several Indic scripts genuinely require - a rule that refused those would be a
 * rule that refuses names, which is worse than the problem it solves.
 *
 * Every class below is written as escapes rather than as the characters
 * themselves. A file carrying a literal zero-width space in a character class is
 * a file nobody can review.
 */

/**
 * Invisible, control, and direction-changing characters.
 *
 * U+200C (zero-width non-joiner) and U+200D (zero-width joiner) are absent on
 * purpose: Persian, Hindi and others need them between letters to spell a name
 * correctly. They are the emoji joiner as well, which costs nothing here because
 * the pictographs they would join are refused on their own.
 */
const INVISIBLE = new RegExp(
    "[" +
        "\\u0000-\\u001f\\u007f-\\u009f" + // C0 and C1 controls
        "\\u00ad" + // soft hyphen
        "\\u061c\\u180e" + // Arabic letter mark, Mongolian vowel separator
        "\\u200b\\u200e\\u200f" + // zero-width space, left-to-right and right-to-left marks
        "\\u202a-\\u202e" + // the embedding and override pair
        "\\u2060-\\u2064\\u2066-\\u206f" + // word joiner, invisible operators, isolates
        "\\ufe00-\\ufe0f" + // variation selectors
        "\\ufeff" + // byte-order mark
        "\\ufff9-\\ufffb" + // interlinear annotation
        "]",
    "u"
);

/**
 * Private-use and tag characters, in every plane that has them.
 *
 * A tag character is a copy of an ASCII letter that renders as nothing, which is
 * the one way to put a readable sentence inside a name nobody can see.
 */
const HIDDEN_PLANES = new RegExp(
    "[\\ue000-\\uf8ff]|[\\u{e0000}-\\u{e007f}]|[\\u{f0000}-\\u{10fffd}]",
    "u"
);

/**
 * What arrives when text has already been mangled - a replacement character, an
 * unpaired surrogate, or an object placeholder. None of them is anything anybody
 * typed, and storing one means storing the damage.
 */
const BROKEN = new RegExp(
    "[\\ufffc\\ufffd]|[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]",
    "u"
);

/**
 * Emoji and pictographs, including the flags - which are pairs of regional
 * indicator letters rather than pictographs, and would otherwise pass.
 */
const PICTOGRAPH = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

export const UNPRINTABLE_NAME_MESSAGE = "Remove the invisible or control characters";
export const EMOJI_NAME_MESSAGE = "Emoji cannot be part of a name";
export const BROKEN_TEXT_MESSAGE = "Some of those characters did not survive being typed";

/** True when the value carries something that renders as nothing, or that
 *  changes how everything after it is drawn. */
export function hasInvisible(value: string): boolean {
    return INVISIBLE.test(value) || HIDDEN_PLANES.test(value);
}

export function hasPictograph(value: string): boolean {
    return PICTOGRAPH.test(value);
}

export function hasBrokenText(value: string): boolean {
    return BROKEN.test(value);
}

/**
 * Why this cannot be a name, or null when it can be.
 *
 * One sentence per reason and the most alarming first, because a field that says
 * "invalid" teaches nobody what to change. An empty value is not this function's
 * business: whether a name is required is a question each field answers for
 * itself.
 */
export function nameRefusal(value: string): string | null {
    if (hasBrokenText(value)) return BROKEN_TEXT_MESSAGE;
    if (hasInvisible(value)) return UNPRINTABLE_NAME_MESSAGE;
    if (hasPictograph(value)) return EMOJI_NAME_MESSAGE;
    return null;
}

/** The same classes, as global patterns, for the one caller that removes rather
 *  than refuses. Built fresh each time: a global regex carries `lastIndex`, and a
 *  shared one would skip half of what it was asked to strip. */
function global(pattern: RegExp): RegExp {
    return new RegExp(pattern.source, `${pattern.flags}g`);
}

/**
 * The same value with the unprintable characters taken out.
 *
 * For the places that must not refuse - a name arriving from a sign-in provider,
 * an import - where the alternative is turning somebody away over a character
 * they did not choose and cannot see. Everything a name is legitimately written
 * with is left exactly as it was, and the result is composed (NFC) so two ways of
 * typing the same accented letter are one string.
 */
export function stripUnprintable(value: string): string {
    return value
        .normalize("NFC")
        .replace(global(INVISIBLE), "")
        .replace(global(HIDDEN_PLANES), "")
        .replace(global(BROKEN), "")
        .replace(global(PICTOGRAPH), "")
        .replace(/\s+/g, " ")
        .trim();
}
