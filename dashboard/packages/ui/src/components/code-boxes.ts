/**
 * The rules of the code boxes, apart from how they are drawn: what a keystroke,
 * a paste or a click does to the code and to the caret. Free of React so the
 * desktop app's plain pages draw the same boxes with the same behaviour
 * (`desktop/src/renderer/code-boxes.ts`).
 */

/** How many digits a code has. `otpCodeField` in `@polaris/core` is the rule. */
export const CODE_LENGTH = 6;

/** What an empty plain box shows: digits that read like a real code, where a row
 *  of zeros reads like a broken field. A number, not a sentence, so it is the
 *  same in every language. */
const EXAMPLE_DIGITS = "482913705162"; // i18n-ignore digits, not words

/** The example an empty box of `length` digits shows. */
export function exampleCode(length = CODE_LENGTH): string {
    return EXAMPLE_DIGITS.repeat(Math.ceil(length / EXAMPLE_DIGITS.length)).slice(0, length);
}

/** Only the digits of what was typed, at most a code's worth. */
export function codeDigits(typed: string, length = CODE_LENGTH): string {
    return typed.replace(/\D/g, "").slice(0, length);
}

/** Whether a code box holds a whole code, which is when its submit may be pressed. */
export function isWholeCode(value: string, length = CODE_LENGTH): boolean {
    return value.length === length;
}

/** Whether this keystroke or paste is the one that completed the code - once,
 *  not again on every render of a box that is already whole. */
export function justCompleted(previous: string, next: string, length = CODE_LENGTH): boolean {
    return !isWholeCode(previous, length) && isWholeCode(next, length);
}

/** Submit the form a box belongs to, after the value it was just given has
 *  rendered - the form's handler reads the code from that render. */
export function submitOwnForm(input: HTMLInputElement): void {
    const form = input.form;
    if (form) window.setTimeout(() => form.requestSubmit(), 0);
}

/** A selection in the hidden input: `[start, end)`, in digits. */
export type CodeSelection = readonly [number, number];

/**
 * Where the selection belongs for a code with `filled` of its `length` digits.
 * A box holding a digit is selected, so typing replaces it; the first empty box
 * gets a bare caret; a whole code keeps its last box, never a caret past the end.
 * `inserting` is the caret left by a deletion inside the code: it stays bare, so
 * the next digit goes back where the deleted one was. A selection of several
 * digits (select-all, a drag) is the reader's and is only kept inside the code.
 */
export function settleSelection(
    start: number,
    end: number,
    filled: number,
    length: number,
    inserting = false
): CodeSelection {
    if (end - start > 1) return [Math.min(start, filled), Math.min(end, filled)];
    let at = Math.max(0, Math.min(start, filled));
    if (at >= length) at = length - 1;
    if (inserting && filled < length) return [at, at];
    return at < filled ? [at, at + 1] : [at, at];
}

/**
 * What a paste of `text` does to `value` with `[start, end)` selected: a whole
 * code replaces everything, wherever the caret is; fewer digits are written over
 * the boxes from the caret on, or replace a selection of several boxes. Returns
 * the new value and where the caret goes, or null when there is no digit in it.
 */
export function pasteInto(
    value: string,
    start: number,
    end: number,
    text: string,
    length = CODE_LENGTH
): { value: string; caret: number } | null {
    const digits = text.replace(/\D/g, "");
    if (!digits) return null;
    if (digits.length >= length) return { value: digits.slice(0, length), caret: length };
    const from = Math.min(start, value.length);
    const to = Math.min(Math.max(end, from), value.length);
    const next = (to - from > 1
        ? value.slice(0, from) + digits + value.slice(to)
        : value.slice(0, from) + digits + value.slice(from + digits.length)
    ).slice(0, length);
    return { value: next, caret: Math.min(from + digits.length, next.length) };
}

/** The box under a point: the one whose span holds `x`, else the nearest. */
export function slotAt(x: number, spans: readonly (readonly [number, number])[]): number {
    let best = 0;
    let distance = Infinity;
    spans.forEach(([left, right], index) => {
        const away = x < left ? left - x : x > right ? x - right : 0;
        if (away < distance) {
            distance = away;
            best = index;
        }
    });
    return best;
}

/** How long the common start of two strings is. */
export function sharedStart(a: string, b: string): number {
    let at = 0;
    while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
    return at;
}
