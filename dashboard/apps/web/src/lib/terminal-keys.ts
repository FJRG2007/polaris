/**
 * The keys a phone's keyboard does not have, for the bar above it in a terminal
 * (the way Termius and Blink do it): Escape, Tab, a Ctrl that holds for the next
 * key, and the arrows. Pure, so what each one sends is asserted in a test.
 */

export const BAR_KEYS = ["esc", "tab", "ctrl", "up", "down", "left", "right"] as const;
export type BarKey = (typeof BAR_KEYS)[number];

const ARROW_LETTER = { up: "A", down: "B", right: "C", left: "D" } as const;

/** What a bar key sends, with Ctrl held or not. Ctrl itself sends nothing: it
 *  only changes the key after it. */
export function barKeySequence(key: BarKey, ctrl: boolean): string {
    switch (key) {
        case "esc":
            return "\u001b";
        case "tab":
            return "\t";
        case "ctrl":
            return "";
        default:
            // xterm's modified cursor keys: CSI 1 ; 5 <letter> is Ctrl+arrow.
            return ctrl ? `\u001b[1;5${ARROW_LETTER[key]}` : `\u001b[${ARROW_LETTER[key]}`;
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

/**
 * How far the on-screen keyboard covers the bottom of the window: the layout
 * viewport's height less what is still visible of it. Zero when nothing covers
 * it, and never negative for a page zoomed or scrolled past its end.
 */
export function keyboardInset(innerHeight: number, visibleHeight: number, visibleTop: number): number {
    return Math.max(0, Math.round(innerHeight - visibleHeight - visibleTop));
}
