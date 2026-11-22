/**
 * The keys a phone's keyboard does not have, for the bar above it in a terminal
 * (the way Termius and Blink do it): Escape, Tab, a Ctrl and an Alt that hold
 * for the next key, the arrows, the symbols a shell leans on, and the control
 * keys pressed most (interrupt, end of input, clear). Also what a keyboard
 * shortcut means to the terminal's clipboard, and what of a terminal "Ask
 * Polar" carries. Pure, so every one is asserted in a test.
 */

export const BAR_KEYS = [
    "esc",
    "tab",
    "ctrl",
    "alt",
    "up",
    "down",
    "left",
    "right",
    "pipe",
    "tilde",
    "slash",
    "dash",
    "ctrlC",
    "ctrlD",
    "ctrlL"
] as const;
export type BarKey = (typeof BAR_KEYS)[number];

/** Bar keys that hold for the next key instead of sending anything. */
export type BarModifier = "ctrl" | "alt";

const ARROW_LETTER = { up: "A", down: "B", right: "C", left: "D" } as const;

/** Bar keys that type a character, and the character. */
const BAR_TEXT = { pipe: "|", tilde: "~", slash: "/", dash: "-" } as const;

/** Bar keys that are a control key on their own. */
const BAR_CONTROL = { ctrlC: "\u0003", ctrlD: "\u0004", ctrlL: "\u000c" } as const;

/** What a bar key shows on its face; null for one drawn as an icon (the
 *  arrows) or labelled through the translations (Esc, Tab, Ctrl, Alt). */
export function barKeyFace(key: BarKey): string | null {
    if (key === "pipe" || key === "tilde" || key === "slash" || key === "dash") return BAR_TEXT[key];
    if (key === "ctrlC") return "^C";
    if (key === "ctrlD") return "^D";
    if (key === "ctrlL") return "^L";
    return null;
}

/** What a bar key sends, with Ctrl (and Alt) held or not. Ctrl and Alt send
 *  nothing themselves: they only change the key after them. Alt is the Escape
 *  prefix, the way xterm sends Meta. */
export function barKeySequence(key: BarKey, ctrl: boolean, alt = false): string {
    const meta = alt ? "\u001b" : "";
    switch (key) {
        case "esc":
            return "\u001b";
        case "tab":
            return `${meta}\t`;
        case "ctrl":
        case "alt":
            return "";
        case "pipe":
        case "tilde":
        case "slash":
        case "dash":
            return `${meta}${ctrl ? withCtrl(BAR_TEXT[key]) : BAR_TEXT[key]}`;
        case "ctrlC":
        case "ctrlD":
        case "ctrlL":
            return `${meta}${BAR_CONTROL[key]}`;
        default: {
            // xterm's modified cursor keys: CSI 1 ; <mod> <letter>, where 3 is
            // Alt, 5 is Ctrl and 7 is both.
            const mod = ctrl && alt ? 7 : ctrl ? 5 : alt ? 3 : 0;
            return mod ? `\u001b[1;${mod}${ARROW_LETTER[key]}` : `\u001b[${ARROW_LETTER[key]}`;
        }
    }
}

/**
 * Typed input with Ctrl held: the first character as its control code (Ctrl+C
 * is 0x03, Ctrl+[ is Escape, Ctrl+Space is NUL), the rest as typed. A character
 * with no control code goes through unchanged.
 */
export function withCtrl(input: string): string {
    if (!input) return input;
    const first = input[0]!;
    const rest = input.slice(1);
    if (first === " " || first === "@") return `\u0000${rest}`;
    if (first === "?") return `\u007f${rest}`;
    const code = first.toUpperCase().charCodeAt(0);
    // "@" (0x40) through "_" (0x5f) map onto 0x00-0x1f.
    if (code >= 0x40 && code <= 0x5f) return `${String.fromCharCode(code - 0x40)}${rest}`;
    return input;
}

/** Typed input with the bar's held modifiers applied. */
export function withModifiers(input: string, ctrl: boolean, alt: boolean): string {
    if (!input) return input;
    const typed = ctrl ? withCtrl(input) : input;
    return alt ? `\u001b${typed}` : typed;
}

/**
 * How far the on-screen keyboard covers the bottom of the window: the layout
 * viewport's height less what is still visible of it. Zero when nothing covers
 * it, and never negative for a page zoomed or scrolled past its end.
 */
export function keyboardInset(innerHeight: number, visibleHeight: number, visibleTop: number): number {
    return Math.max(0, Math.round(innerHeight - visibleHeight - visibleTop));
}

/** The parts of a keyboard event a clipboard shortcut is read from. */
export interface ShortcutEvent {
    readonly type: string;
    readonly key: string;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    readonly metaKey: boolean;
}

/**
 * What a key press means to the terminal's clipboard, the way Windows
 * Terminal, GNOME Terminal and VS Code read it:
 *
 * - Ctrl+Shift+C / Ctrl+Shift+V (and Ctrl+Insert / Shift+Insert) always copy
 *   and paste;
 * - Ctrl+C copies when something is selected and is the interrupt (^C)
 *   otherwise, so a running command can always be stopped;
 * - Ctrl+V pastes. Left to xterm it is ^V (quoted insert), and xterm cancels
 *   the key, so the browser never raised the paste - which is why pasting with
 *   it did nothing;
 * - on a Mac it is Cmd+C and Cmd+V, and Ctrl+C is always the interrupt.
 *
 * `null` leaves the key to the terminal. Only a keydown is a shortcut.
 */
export function clipboardShortcut(
    event: ShortcutEvent,
    hasSelection: boolean,
    mac: boolean
): "copy" | "paste" | null {
    if (event.type !== "keydown" || event.altKey) return null;
    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
    if (mac) {
        if (!event.metaKey || event.ctrlKey) return null;
        if (key === "c") return hasSelection ? "copy" : null;
        return key === "v" ? "paste" : null;
    }
    if (event.metaKey) return null;
    if (key === "Insert") {
        if (event.shiftKey && !event.ctrlKey) return "paste";
        if (event.ctrlKey && !event.shiftKey) return hasSelection ? "copy" : null;
        return null;
    }
    if (!event.ctrlKey) return null;
    if (event.shiftKey) return key === "c" ? "copy" : key === "v" ? "paste" : null;
    if (key === "c") return hasSelection ? "copy" : null;
    return key === "v" ? "paste" : null;
}

/** Whether this device's shortcuts use Cmd rather than Ctrl. */
export function isMacPlatform(platform: string): boolean {
    return /Mac|iPhone|iPad|iPod/i.test(platform);
}

/** Most lines of a terminal's output one "Ask Polar" carries. */
export const POLAR_LINES = 200;

/**
 * What of a terminal to hand Polar: the selection when there is one, else the
 * last `POLAR_LINES` lines of output, trailing blank lines dropped and each
 * line's end trimmed, then cut to `maxChars` from the START at a line break,
 * so the newest lines - where the error is - always survive. Null when there
 * is nothing to send.
 */
export function terminalExcerpt(
    lines: readonly string[],
    selection: string,
    maxChars: number
): { text: string; source: "selection" | "output" } | null {
    const tidy = (text: string): string =>
        text
            .replace(/\r\n?/g, "\n")
            .split("\n")
            .map((line) => line.trimEnd())
            .join("\n")
            .trim();
    const tail = (text: string): string => {
        if (text.length <= maxChars) return text;
        const cut = text.slice(text.length - maxChars);
        const firstBreak = cut.indexOf("\n");
        return firstBreak >= 0 && firstBreak < cut.length - 1 ? cut.slice(firstBreak + 1) : cut;
    };
    const selected = tidy(selection);
    if (selected) return { text: tail(selected), source: "selection" };
    let end = lines.length;
    while (end > 0 && lines[end - 1]!.trim() === "") end -= 1;
    const output = tidy(lines.slice(Math.max(0, end - POLAR_LINES), end).join("\n"));
    return output ? { text: tail(output), source: "output" } : null;
}

/** Where a viewer's terminal layout is remembered, on this browser only. */
export const TERMINAL_LAYOUT_KEY = "polaris:terminal-layout";

/** How a viewer likes the terminal: filling the window, and the key bar shown.
 *  `keys` null means "the default for this device" (shown on touch screens). */
export interface TerminalLayout {
    readonly maximized: boolean;
    readonly keys: boolean | null;
}

export const DEFAULT_TERMINAL_LAYOUT: TerminalLayout = { maximized: false, keys: null };

/** A stored layout read back; anything unreadable is the default. */
export function parseTerminalLayout(raw: string | null): TerminalLayout {
    if (!raw) return DEFAULT_TERMINAL_LAYOUT;
    try {
        const value = JSON.parse(raw) as { maximized?: unknown; keys?: unknown };
        return {
            maximized: value.maximized === true,
            keys: typeof value.keys === "boolean" ? value.keys : null
        };
    } catch {
        return DEFAULT_TERMINAL_LAYOUT;
    }
}
