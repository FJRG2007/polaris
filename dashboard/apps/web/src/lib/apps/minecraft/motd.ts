/**
 * The message of the day: the two lines under a server's name in the multiplayer
 * list, and the formatting codes Minecraft renders them with.
 *
 * A MOTD is not plain text. It carries section-sign codes that set a colour or a
 * style, they persist until something resets them, and they survive a line break -
 * so a line typed on its own does not render on its own. That is exactly the sort
 * of thing nobody can hold in their head while typing, which is why this exists to
 * drive a live preview rather than leaving an operator to save, restart, and go and
 * look at the server list.
 *
 * Pure on purpose: the editor renders the preview in the browser from these, and
 * the action encodes the stored value with the same functions, so what is previewed
 * and what is written cannot drift.
 */

/** How the code is written while editing. Minecraft's own is the section sign,
 *  which no keyboard has, so `&` is what everyone actually types. */
export const AMPERSAND = "&";

/** What the server.properties file has to carry. */
export const SECTION = "§";

/** The sixteen colours, by code. */
export const MOTD_COLORS: Readonly<Record<string, { readonly name: string; readonly hex: string }>> = {
    "0": { name: "Black", hex: "#000000" },
    "1": { name: "Dark blue", hex: "#0000AA" },
    "2": { name: "Dark green", hex: "#00AA00" },
    "3": { name: "Dark aqua", hex: "#00AAAA" },
    "4": { name: "Dark red", hex: "#AA0000" },
    "5": { name: "Dark purple", hex: "#AA00AA" },
    "6": { name: "Gold", hex: "#FFAA00" },
    "7": { name: "Gray", hex: "#AAAAAA" },
    "8": { name: "Dark gray", hex: "#555555" },
    "9": { name: "Blue", hex: "#5555FF" },
    a: { name: "Green", hex: "#55FF55" },
    b: { name: "Aqua", hex: "#55FFFF" },
    c: { name: "Red", hex: "#FF5555" },
    d: { name: "Light purple", hex: "#FF55FF" },
    e: { name: "Yellow", hex: "#FFFF55" },
    f: { name: "White", hex: "#FFFFFF" }
};

/** The style codes, which stack on top of a colour instead of replacing it. */
export const MOTD_STYLES: Readonly<Record<string, string>> = {
    k: "Obfuscated",
    l: "Bold",
    m: "Strikethrough",
    n: "Underline",
    o: "Italic"
};

/** The code that clears everything back to plain white. */
export const RESET = "r";

/** What the server list paints behind the text, for a preview that is honest about
 *  contrast - dark grey on black is a real way to make a MOTD unreadable. */
export const MOTD_BACKGROUND = "#101010";

/** The colour text starts in when nothing has been set. */
const DEFAULT_COLOR = MOTD_COLORS.f?.hex ?? "#FFFFFF";

/** A run of characters that share one set of formatting. */
export interface MotdSpan {
    readonly text: string;
    readonly color: string;
    readonly bold: boolean;
    readonly italic: boolean;
    readonly underline: boolean;
    readonly strikethrough: boolean;
    /** Minecraft scrambles these characters every frame; the preview stands in for
     *  that rather than animating it. */
    readonly obfuscated: boolean;
}

interface MotdState {
    color: string;
    bold: boolean;
    italic: boolean;
    underline: boolean;
    strikethrough: boolean;
    obfuscated: boolean;
}

function freshState(): MotdState {
    return {
        color: DEFAULT_COLOR,
        bold: false,
        italic: false,
        underline: false,
        strikethrough: false,
        obfuscated: false
    };
}

/** Whether a character is a code this understands, in either notation. */
export function isFormatCode(character: string): boolean {
    const code = character.toLowerCase();
    return code === RESET || code in MOTD_COLORS || code in MOTD_STYLES;
}

/**
 * Split one line into its formatted runs.
 *
 * State carries across the whole line and a colour clears the styles with it,
 * which is Minecraft's rule and the one that surprises people: `&lBold &cRed` is
 * not bold red, the colour dropped the bold. The preview only tells the truth if
 * it reproduces that.
 */
function spansForLine(line: string, state: MotdState): MotdSpan[] {
    const spans: MotdSpan[] = [];
    let text = "";

    const flush = (): void => {
        if (text.length === 0) return;
        spans.push({
            text,
            color: state.color,
            bold: state.bold,
            italic: state.italic,
            underline: state.underline,
            strikethrough: state.strikethrough,
            obfuscated: state.obfuscated
        });
        text = "";
    };

    for (let index = 0; index < line.length; index += 1) {
        const character = line[index] as string;
        const marker = character === AMPERSAND || character === SECTION;
        const code = marker ? (line[index + 1] ?? "").toLowerCase() : "";
        if (!marker || !isFormatCode(code)) {
            text += character;
            continue;
        }
        flush();
        index += 1;
        if (code === RESET) {
            Object.assign(state, freshState());
        } else if (code in MOTD_COLORS) {
            // A colour resets the styles - Minecraft's rule, not a simplification.
            Object.assign(state, freshState(), { color: MOTD_COLORS[code]?.hex ?? DEFAULT_COLOR });
        } else if (code === "l") {
            state.bold = true;
        } else if (code === "o") {
            state.italic = true;
        } else if (code === "n") {
            state.underline = true;
        } else if (code === "m") {
            state.strikethrough = true;
        } else if (code === "k") {
            state.obfuscated = true;
        }
    }
    flush();
    return spans;
}

/**
 * The whole MOTD as the client would draw it: at most two lines of runs.
 *
 * Formatting carries from the first line into the second, because the stored value
 * is one string with a newline in it and nothing resets at the break.
 */
export function motdSpans(text: string): MotdSpan[][] {
    const state = freshState();
    return motdLines(text).map((line) => spansForLine(line, state));
}

/** The lines of a MOTD, capped at the two the client shows. */
export function motdLines(text: string): string[] {
    return text.replace(/\r/g, "").split("\n").slice(0, MOTD_MAX_LINES);
}

/** The client draws two and silently drops the rest. */
export const MOTD_MAX_LINES = 2;

/**
 * Character widths of Minecraft's default font, in pixels, including the one-pixel
 * gap after each. Only the exceptions are listed; everything else is six.
 *
 * Needed because centring a MOTD is not padding to a character count - the font is
 * not fixed width, and an `i` is a third of an `m`. Getting this wrong produces a
 * line that looks centred in the editor and sits off to one side in the game.
 */
const GLYPH_WIDTHS: Readonly<Record<string, number>> = {
    " ": 4,
    "!": 2,
    '"': 5,
    "'": 3,
    "(": 5,
    ")": 5,
    "*": 5,
    ",": 2,
    ".": 2,
    ":": 2,
    ";": 2,
    "<": 5,
    ">": 5,
    "@": 7,
    I: 4,
    "[": 4,
    "]": 4,
    f: 5,
    i: 2,
    k: 5,
    l: 3,
    t: 4,
    "{": 5,
    "}": 5,
    "|": 2,
    "`": 3,
    "~": 7
};

const DEFAULT_GLYPH_WIDTH = 6;
const SPACE_WIDTH = GLYPH_WIDTHS[" "] ?? 4;

/** How wide the server list draws a MOTD before it clips. */
export const MOTD_PIXEL_WIDTH = 270;

/** How wide one line renders, ignoring the codes, which draw nothing. */
export function motdLineWidth(line: string): number {
    let width = 0;
    for (const span of spansForLine(line, freshState())) {
        for (const character of span.text) {
            width += (GLYPH_WIDTHS[character] ?? DEFAULT_GLYPH_WIDTH) + (span.bold ? 1 : 0);
        }
    }
    return width;
}

/**
 * Pad each line with spaces so it sits in the middle of the server list.
 *
 * Leading spaces are dropped first so centring twice does not walk the text
 * rightwards, and a line already too wide to fit is left alone rather than pushed
 * further out.
 */
export function centerMotd(text: string): string {
    return motdLines(text)
        .map((line) => {
            const bare = line.replace(/^ +/, "");
            const width = motdLineWidth(bare);
            if (width >= MOTD_PIXEL_WIDTH) return bare;
            const pad = Math.round((MOTD_PIXEL_WIDTH - width) / 2 / SPACE_WIDTH);
            return `${" ".repeat(Math.max(0, pad))}${bare}`;
        })
        .join("\n");
}

/** The padding taken back off, which is what centring added and nothing else. */
export function uncenterMotd(text: string): string {
    return motdLines(text)
        .map((line) => line.replace(/^ +/, ""))
        .join("\n");
}

/** Whether the lines are already sitting in the middle. A line with no padding at
 *  all is not centred, which is what stops a MOTD that happens to be exactly wide
 *  enough from reading as centred and refusing to be centred. */
export function isCenteredMotd(text: string): boolean {
    const lines = motdLines(text).filter((line) => line.trim().length > 0);
    if (lines.length === 0) return false;
    return lines.every((line) => line.startsWith(" ")) && centerMotd(text) === motdLines(text).join("\n");
}

/** Centre the lines, or put them back against the left if they already are. */
export function toggleCenterMotd(text: string): string {
    return isCenteredMotd(text) ? uncenterMotd(text) : centerMotd(text);
}

/**
 * The value the container's MOTD variable has to hold.
 *
 * It is read by the image's entrypoint, which writes server.properties from it, so
 * this is that form and not the one a hand-edited file would take: the section sign
 * goes in literally, and the line break as the two characters `\n` - a real newline
 * would end the property and lose the second line.
 */
export function encodeMotd(text: string): string {
    return motdLines(text)
        .map((line) => line.replace(new RegExp(AMPERSAND, "g"), SECTION))
        .join("\\n");
}

/**
 * Read a stored value back into what the editor shows.
 *
 * The `§` escape is accepted as well as the sign itself, because that is the
 * form every MOTD generator on the web emits and pasting one in is the obvious
 * thing to do with this field.
 */
export function decodeMotd(stored: string): string {
    return stored
        .replace(/\\u00A7/gi, AMPERSAND)
        .replace(new RegExp(SECTION, "g"), AMPERSAND)
        .replace(/\\n/g, "\n");
}

/** The MOTD with every code removed, which is what a client that cannot render
 *  them shows and what a search listing indexes. */
export function stripMotd(text: string): string {
    return motdSpans(text)
        .map((spans) => spans.map((span) => span.text).join(""))
        .join("\n");
}

/** The codes in force at a point: a colour, and the styles stacked on it. */
export interface MotdCodes {
    /** The colour code, or null while nothing has set one. */
    readonly color: string | null;
    readonly styles: readonly string[];
}

const NO_CODES: MotdCodes = { color: null, styles: [] };

/**
 * Where every visible character sits in the stored string, and what formatting is
 * in force there.
 *
 * The editor works in the text a person sees and the server stores the text with
 * the codes in it, and the two do not line up: `&aHello` is six characters to a
 * reader and eight to the file. Anything that turns a selection into an edit -
 * colouring a word, typing in the middle of one - has to cross that gap, and this
 * is the only place that crossing is worked out.
 */
export interface MotdMap {
    /** The text with the codes taken out, which is what the editor shows. */
    readonly plain: string;
    /** Where visible character `i` begins in the raw string. One longer than
     *  `plain`, so the end of the text has an offset too. */
    readonly offsets: readonly number[];
    /** What is in force immediately before visible character `i`. Same length as
     *  `offsets`, for the same reason. */
    readonly codes: readonly MotdCodes[];
}

export function motdMap(raw: string): MotdMap {
    const offsets: number[] = [];
    const codes: MotdCodes[] = [];
    let plain = "";
    let current: MotdCodes = NO_CODES;

    for (let index = 0; index < raw.length; index += 1) {
        const character = raw[index] as string;
        const marker = character === AMPERSAND || character === SECTION;
        const code = marker ? (raw[index + 1] ?? "").toLowerCase() : "";
        if (marker && isFormatCode(code)) {
            index += 1;
            if (code === RESET) current = NO_CODES;
            // A colour clears the styles with it, which is the game's rule and
            // the one that has to survive into what gets written back.
            else if (code in MOTD_COLORS) current = { color: code, styles: [] };
            else current = { color: current.color, styles: [...new Set([...current.styles, code])] };
            continue;
        }
        offsets.push(index);
        codes.push(current);
        plain += character;
    }
    offsets.push(raw.length);
    codes.push(current);
    return { plain, offsets, codes };
}

/**
 * What is in force across a stretch of the text, for a toolbar that has to show
 * which of its buttons are already pressed.
 *
 * Only what every character shares. A selection that is half bold is not bold -
 * pressing the button on it should finish the job, and a button that claimed it
 * was already done would be lying about what the next press will do. A caret
 * reports what it sits in, which is what the next character typed will get.
 */
export function codesOver(map: MotdMap, start: number, end: number): MotdCodes {
    const from = Math.max(0, Math.min(start, map.plain.length));
    const to = Math.max(from, Math.min(end, map.plain.length));
    const first = map.codes[from] ?? NO_CODES;
    if (from === to) return first;
    let color = first.color;
    let styles = [...first.styles];
    for (let index = from + 1; index < to; index += 1) {
        const codes = map.codes[index] ?? NO_CODES;
        if (codes.color !== color) color = null;
        styles = styles.filter((style) => codes.styles.includes(style));
    }
    return { color, styles };
}

/** The visible character a raw offset falls on, for a caret that was placed in
 *  the stored string rather than in the text. A caret inside a code belongs to the
 *  character the code introduces. */
export function plainIndexAt(map: MotdMap, rawIndex: number): number {
    const found = map.offsets.findIndex((offset) => offset >= rawIndex);
    return found === -1 ? map.plain.length : found;
}

function sameCodes(left: MotdCodes, right: MotdCodes): boolean {
    return (
        left.color === right.color &&
        left.styles.length === right.styles.length &&
        left.styles.every((style) => right.styles.includes(style))
    );
}

/**
 * The codes that get from one formatting to another.
 *
 * Adding a style is the style's own code and nothing else. Everything else - a
 * different colour, or a style being taken off - has to go through a code that
 * clears, because there is no "stop being bold" in Minecraft: the only way back
 * is a colour or a reset, both of which drop every style, so whatever should
 * survive is re-stated after it.
 */
function transitionCodes(from: MotdCodes, to: MotdCodes): string {
    if (sameCodes(from, to)) return "";
    const dropped = from.styles.some((style) => !to.styles.includes(style));
    if (from.color !== to.color || dropped) {
        const head = to.color ? `${AMPERSAND}${to.color}` : `${AMPERSAND}${RESET}`;
        return head + to.styles.map((style) => `${AMPERSAND}${style}`).join("");
    }
    return to.styles
        .filter((style) => !from.styles.includes(style))
        .map((style) => `${AMPERSAND}${style}`)
        .join("");
}

/** Write the visible text back out with a formatting per character, emitting a
 *  code only where one character differs from the one before it. */
function encodeMotdCodes(plain: string, codes: readonly MotdCodes[]): string {
    let out = "";
    let active: MotdCodes = NO_CODES;
    for (let index = 0; index < plain.length; index += 1) {
        const wanted = codes[index] ?? NO_CODES;
        out += transitionCodes(active, wanted);
        active = wanted;
        out += plain[index];
    }
    return out;
}

/** Whether a code is already in force. A reset is "in force" when there is
 *  nothing to reset. */
function codeIsOn(codes: MotdCodes, code: string): boolean {
    if (code === RESET) return codes.color === null && codes.styles.length === 0;
    if (code in MOTD_COLORS) return codes.color === code;
    return codes.styles.includes(code);
}

/** One character's formatting with a code turned on or off. A colour keeps the
 *  styles under it: colouring a bold word should leave it bold, whatever the
 *  section-sign notation does on its own. */
function withCode(codes: MotdCodes, code: string, on: boolean): MotdCodes {
    if (code === RESET) return NO_CODES;
    if (code in MOTD_COLORS) return { color: on ? code : null, styles: codes.styles };
    return {
        color: codes.color,
        styles: on ? [...new Set([...codes.styles, code])].sort() : codes.styles.filter((style) => style !== code)
    };
}

/**
 * Turn one code on or off over a stretch of the visible text.
 *
 * It toggles, like every other editor: a selection that is already obfuscated
 * stops being obfuscated when the button is pressed again. The first version only
 * ever added, so pressing a style twice stacked a second code and there was no way
 * back to plain except deleting the text - which is a formatting button nobody can
 * trust and the reason people go and edit the codes by hand.
 *
 * The stretch is re-written from a formatting per character rather than wrapped in
 * markers, because taking a style off cannot be expressed by inserting anything:
 * there is no "stop being bold" in Minecraft, only codes that clear everything. It
 * also means the codes come out minimal - one where something changes, none where
 * nothing does.
 *
 * A colour keeps the styles under it. The notation does not, which is why the
 * whole run has to be re-stated; what an operator means by colouring a bold word
 * is not "and stop it being bold".
 *
 * With nothing selected there is nothing to re-write, so the caret takes the code
 * that applies from there on - and toggling there means the codes that switch it
 * back off.
 */
export function applyMotdCode(
    raw: string,
    /** Offsets into the visible text, as a text field reports them. */
    start: number,
    end: number,
    code: string
): { readonly text: string; readonly start: number; readonly end: number } {
    const map = motdMap(raw);
    const from = Math.max(0, Math.min(start, map.plain.length));
    const to = Math.max(from, Math.min(end, map.plain.length));

    if (from === to) {
        const here = map.codes[from] ?? NO_CODES;
        const token = transitionCodes(here, withCode(here, code, !codeIsOn(here, code)));
        const rawFrom = map.offsets[from] ?? raw.length;
        return { text: raw.slice(0, rawFrom) + token + raw.slice(rawFrom), start: from, end: from };
    }

    // Off only when every character already has it: a half-formatted selection is
    // one somebody is trying to finish, not undo.
    const selected = map.codes.slice(from, to);
    const on = !selected.every((codes) => codeIsOn(codes, code));
    const next = map.codes.map((codes, index) => (index >= from && index < to ? withCode(codes, code, on) : codes));
    return { text: encodeMotdCodes(map.plain, next), start: from, end: to };
}

/**
 * Put edited visible text back into the stored string, keeping its formatting.
 *
 * The editor hands a person the text without the codes, so every keystroke has to
 * be folded back into a string they never see. One contiguous change is assumed,
 * which is what typing, pasting and deleting a selection all are - so the common
 * head and tail are found and only what lies between them is replaced.
 *
 * The codes at the seam are deliberately kept: typing at the end of a coloured
 * word extends the colour, which is what somebody watching the preview expects,
 * rather than dropping the new characters into whatever came before it.
 */
export function replaceMotdPlain(raw: string, nextPlain: string): string {
    const map = motdMap(raw);
    const previous = map.plain;
    if (previous === nextPlain) return raw;

    let head = 0;
    while (head < previous.length && head < nextPlain.length && previous[head] === nextPlain[head]) head += 1;
    let tail = 0;
    while (
        tail < previous.length - head &&
        tail < nextPlain.length - head &&
        previous[previous.length - 1 - tail] === nextPlain[nextPlain.length - 1 - tail]
    ) {
        tail += 1;
    }

    const removedTo = previous.length - tail;
    // The head's own offset is where the replacement starts. Its end is the
    // offset of the first character kept, so any codes sitting between the two
    // are dropped along with the text they were introducing.
    const rawFrom = map.offsets[head] ?? raw.length;
    const rawTo = map.offsets[removedTo] ?? raw.length;
    return raw.slice(0, rawFrom) + nextPlain.slice(head, nextPlain.length - tail) + raw.slice(rawTo);
}
