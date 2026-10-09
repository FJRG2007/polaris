/**
 * A space's own emoji: the rules for one, and the form it takes in a message.
 *
 * Pure and shared, so the upload form checks a name as it is typed with exactly
 * the function the server checks it with on the way in, and the composer, the
 * renderer and the send path all read a message's emoji with one parser.
 *
 * An emoji belongs to one space and is only ever drawn inside it. A message
 * carries it as `<:name:id>` - `<a:name:id>` when it moves - which is the shape
 * Discord settled on: the id is what it points at, so renaming the emoji never
 * breaks a message already sent, and the name is there so that anything which
 * cannot draw the picture - a space the reader is not in, an emoji deleted since,
 * a notification, a copy pasted somewhere else - still has a word to show.
 */

import { z } from "zod";

/** How many of each kind a space may keep: fifty still, fifty moving. */
export const CUSTOM_EMOJI_SLOTS = 50;

/** The biggest file one may be, in bytes. */
export const CUSTOM_EMOJI_MAX_BYTES = 256 * 1024;

/** The widest or tallest one may be, in pixels. Anything past it is a photograph
 *  rather than an emoji, and decoding it costs every reader for nothing. */
export const CUSTOM_EMOJI_MAX_SIDE = 2048;

export const CUSTOM_EMOJI_NAME_MIN = 2;
export const CUSTOM_EMOJI_NAME_MAX = 32;

/** What the bytes may turn out to be. Never SVG: a document that can carry script. */
export const CUSTOM_EMOJI_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

export type CustomEmojiType = (typeof CUSTOM_EMOJI_TYPES)[number];

/** What a file picker is told to offer. A hint, never the check. */
export const CUSTOM_EMOJI_ACCEPT = ".png,.jpg,.jpeg,.gif,.webp,image/png,image/jpeg,image/gif,image/webp";

/** Why a name is refused, as a word a screen turns into a sentence. */
export type CustomEmojiNameProblem = "short" | "long" | "characters" | "edges";

/**
 * A typed name, as it is stored.
 *
 * Trimmed, and stripped of the colons somebody types out of habit - `:wave:` is
 * the name `wave`. Case is kept: `PogChamp` is what its uploader meant, and
 * uniqueness is decided on the lowercased form instead (`customEmojiNameKey`).
 */
export function normalizeEmojiName(raw: string): string {
    return raw.trim().replace(/^:+|:+$/g, "").trim();
}

/** The form two names are compared in, so `Wave` and `wave` cannot both exist. */
export function customEmojiNameKey(name: string): string {
    return normalizeEmojiName(name).toLowerCase();
}

/**
 * What is wrong with a name, or null when nothing is.
 *
 * Letters, digits and underscores, two to thirty-two of them - Discord's rule,
 * with one addition: an underscore may not open or close the name. A message is
 * Markdown, and `_` at the edge of a word is where emphasis starts, so two such
 * emoji in one line would read as italics around everything between them.
 */
export function emojiNameProblem(name: string): CustomEmojiNameProblem | null {
    if (name.length < CUSTOM_EMOJI_NAME_MIN) return "short";
    if (name.length > CUSTOM_EMOJI_NAME_MAX) return "long";
    if (!/^[A-Za-z0-9_]+$/.test(name)) return "characters";
    if (name.startsWith("_") || name.endsWith("_")) return "edges";
    return null;
}

/**
 * The name a file suggests, before anybody edits it.
 *
 * The file's own name without its extension, every run of characters a name
 * cannot hold turned into one underscore, and trimmed to the longest a name can
 * be. Not guaranteed valid - `a.png` suggests `a`, which is too short - and that
 * is deliberate: the screen says so beside the file, rather than inventing a
 * name the uploader never chose.
 */
export function emojiNameFromFile(fileName: string): string {
    const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]*$/, "");
    return base
        .replace(/[^A-Za-z0-9_]+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, CUSTOM_EMOJI_NAME_MAX)
        .replace(/_+$/, "");
}

/** A name in a request: normalized first, then checked - the same two steps the
 *  form takes as it is typed. The issue's message is the problem's word. */
export const customEmojiNameSchema = z
    .string()
    .max(200)
    .transform(normalizeEmojiName)
    .superRefine((name, context) => {
        const problem = emojiNameProblem(name);
        if (problem) context.addIssue({ code: "custom", message: problem });
    });

export const customEmojiRenameSchema = z.object({
    emojiId: z.string().uuid(),
    name: customEmojiNameSchema
});

export type CustomEmojiRenameInput = z.infer<typeof customEmojiRenameSchema>;

export const customEmojiDeleteSchema = z.object({ emojiId: z.string().uuid() });

/** The upload's fields beside the file itself, which is checked as bytes. */
export const customEmojiUploadSchema = z.object({
    spaceId: z.string().uuid(),
    name: customEmojiNameSchema
});

// ---------------------------------------------------------------------------
// The token in a message
// ---------------------------------------------------------------------------

/** One custom emoji, as a message names it. */
export interface CustomEmojiRef {
    readonly id: string;
    readonly name: string;
    readonly animated: boolean;
}

const UUID = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const TOKEN = `<(a?):([A-Za-z0-9_]{${CUSTOM_EMOJI_NAME_MIN},${CUSTOM_EMOJI_NAME_MAX}}):(${UUID})>`;

/** A fresh global matcher: a shared one carries `lastIndex` between callers. */
function tokens(): RegExp {
    return new RegExp(TOKEN, "g");
}

function refOf(match: RegExpMatchArray): CustomEmojiRef {
    return { animated: match[1] === "a", name: match[2]!, id: match[3]!.toLowerCase() };
}

/** How a message writes one. */
export function customEmojiToken(ref: CustomEmojiRef): string {
    return `<${ref.animated ? "a" : ""}:${ref.name}:${ref.id.toLowerCase()}>`;
}

/** What stands in for one that cannot be drawn: the name, the way it was typed. */
export function customEmojiFallback(ref: Pick<CustomEmojiRef, "name">): string {
    return `:${ref.name}:`;
}

/** The emoji a whole string is, or null when it is anything else. */
export function parseCustomEmojiToken(value: string): CustomEmojiRef | null {
    const match = new RegExp(`^${TOKEN}$`).exec(value.trim());
    return match ? refOf(match) : null;
}

/** Every emoji a piece of text names, in order, repeats included. */
export function customEmojiRefs(text: string): CustomEmojiRef[] {
    return [...text.matchAll(tokens())].map(refOf);
}

/** A run of text, split into its words and its emoji, for a renderer. */
export type CustomEmojiPart =
    | { readonly text: string; readonly emoji?: undefined }
    | { readonly emoji: CustomEmojiRef; readonly text?: undefined };

export function splitCustomEmoji(text: string): CustomEmojiPart[] {
    const parts: CustomEmojiPart[] = [];
    let at = 0;
    for (const match of text.matchAll(tokens())) {
        const start = match.index ?? 0;
        if (start > at) parts.push({ text: text.slice(at, start) });
        parts.push({ emoji: refOf(match) });
        at = start + match[0].length;
    }
    if (at < text.length) parts.push({ text: text.slice(at) });
    return parts;
}

/** The text with each emoji replaced by whatever `by` answers for it. */
export function replaceCustomEmoji(text: string, by: (ref: CustomEmojiRef) => string): string {
    if (!text.includes("<")) return text;
    return text.replace(tokens(), (...match) => by(refOf(match as unknown as RegExpMatchArray)));
}

/** The text with every emoji said as its name: what a plain-text reader sees. */
export function customEmojiAsText(text: string): string {
    return replaceCustomEmoji(text, customEmojiFallback);
}

// ---------------------------------------------------------------------------
// A message that is only emoji
// ---------------------------------------------------------------------------

/** Past this many, emoji are drawn at the ordinary size again - Discord's 27. */
export const JUMBO_EMOJI_MOST = 27;

/** One pictograph with whatever joins or modifies it: a family, a flag, a skin tone. */
const PICTOGRAPHS =
    /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|\p{Regional_Indicator}|‍|️|[\u{E0020}-\u{E007F}])*$/u;

/** Keycaps (`1️⃣`, `#️⃣`) start with an ordinary character, so they are counted first. */
const KEYCAP = /[#*0-9]️?⃣/gu;

/**
 * How many emoji a line is made of, or zero when it holds anything else.
 *
 * What decides whether a message is drawn large. Whitespace between them is not
 * text; a digit, a letter or a punctuation mark is, and one of them anywhere
 * keeps the whole line ordinary.
 */
export function emojiOnlyCount(text: string): number {
    let count = 0;
    const rest = text
        .replace(tokens(), () => {
            count += 1;
            return "";
        })
        .replace(/\s+/g, "")
        .replace(KEYCAP, () => {
            count += 1;
            return "";
        });
    if (!rest) return count;
    if (!PICTOGRAPHS.test(rest)) return 0;
    return count + graphemes(rest);
}

/** How many characters a reader would count, a family emoji being one. */
function graphemes(text: string): number {
    const Segmenter = (Intl as { Segmenter?: typeof Intl.Segmenter }).Segmenter;
    if (Segmenter) return [...new Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
    return (text.match(/\p{Extended_Pictographic}|\p{Regional_Indicator}{2}/gu) ?? []).length;
}
