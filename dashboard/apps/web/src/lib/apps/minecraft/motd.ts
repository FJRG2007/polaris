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
