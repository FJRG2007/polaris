"use client";

/**
 * The boxes a code of a known number of digits is typed into: one Polaris sent,
 * one from an authenticator app, a PIN, or a chat lock code. One box per digit.
 *
 * The boxes are only drawn. Underneath them is one real, transparent input that
 * holds the whole code, the technique of input-otp (github.com/guilhermerodz/input-otp,
 * what shadcn/ui's InputOTP wraps): paste, an SMS or password-manager autofill,
 * a phone keyboard and a screen reader all meet an ordinary text field, with one
 * label and one tab stop, instead of six inputs that each break paste and
 * Backspace in their own way.
 *
 * What the caret does, so a wrong digit is fixed without retyping the rest:
 * - the box being typed into is selected, so a digit replaces what it holds and
 *   the next box is selected after it; clicking or tapping any filled box, or the
 *   arrows, Home and End, move there;
 * - Backspace on the empty box after the code deletes the last digit and moves
 *   back; on a filled box it deletes that digit, closes the gap, and leaves the
 *   caret where it was, so the next digit typed goes back in its place;
 * - a paste of a whole code fills every box wherever the caret is; a shorter one
 *   fills from the caret on. Spaces and dashes in it ("123 456") are dropped.
 *
 * Digits only: a letter or a space is refused before it lands, so the caret never
 * jumps. No `maxLength` on the element on purpose: the browser truncates a paste
 * before anything sees it, which would cut "123 456" to "123 45". The length is
 * enforced here instead. A code reads left to right in every language, like the
 * numbers it is made of, so the boxes do not mirror.
 *
 * With `autoSubmit`, the boxes submit their form the moment the last digit lands,
 * typed, pasted or autofilled, once. Only where the code is the last thing the
 * form asks for: a form with another field after it waits for its button.
 */

import { Eye, EyeOff } from "lucide-react";
import { cn } from "../lib/cn";
import { useUiStrings } from "../lib/ui-strings";
import { Input, type InputProps } from "./input";
import { useCallback, useLayoutEffect, useRef, useState, type ReactNode, type Ref } from "react";

/** How many digits a code has. `otpCodeField` in `@polaris/core` is the rule. */
export const CODE_LENGTH = 6;

/** What an empty plain box shows: digits that read like a real code, where a row
 *  of zeros reads like a broken field. A number, not a sentence, so it is the
 *  same in every language. */
const EXAMPLE_DIGITS = "482913705162"; // i18n-ignore digits, not words

/** What a hidden digit is drawn as. */
const HIDDEN_DIGIT = "•"; // i18n-ignore a dot, not a word

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
function sharedStart(a: string, b: string): number {
    let at = 0;
    while (at < a.length && at < b.length && a[at] === b[at]) at += 1;
    return at;
}

export type CodeInputProps = Omit<InputProps, "value" | "onChange" | "type" | "maxLength"> & {
    value: string;
    onValueChange: (value: string) => void;
    ref?: Ref<HTMLInputElement>;
    /** How many digits the code has. */
    length?: number;
    /** Drawn as dots, with the show/hide toggle - for a code that is a secret. */
    masked?: boolean;
    /** Submit the form once the last digit is typed. */
    autoSubmit?: boolean;
    /** On by default: a code box appears because a code was just sent, so
     *  the next thing anybody does is type it. Off only where it shares a
     *  screen with a field that comes first. */
    autoFocus?: boolean;
    /** One box per digit, on by default. Off only where the length is not known
     *  (a PIN from before its length was recorded): then it is one plain box,
     *  since drawing six boxes would claim a length. */
    boxes?: boolean;
};

export function CodeInput({ boxes = true, ...props }: CodeInputProps) {
    return boxes ? <CodeBoxes {...props} /> : <PlainCodeInput {...props} />;
}

/** The single box, for a code whose length is not known. */
function PlainCodeInput({
    value,
    onValueChange,
    length = CODE_LENGTH,
    masked = false,
    autoSubmit = false,
    autoFocus = true,
    ...props
}: Omit<CodeInputProps, "boxes">) {
    return (
        <Input
            inputMode="numeric"
            autoComplete={masked ? "off" : "one-time-code"}
            placeholder={exampleCode(length)}
            autoFocus={autoFocus}
            {...props}
            type={masked ? "password" : "text"}
            value={value}
            onChange={(event) => {
                const next = codeDigits(event.target.value, length);
                onValueChange(next);
                if (autoSubmit && justCompleted(value, next, length))
                    submitOwnForm(event.currentTarget);
            }}
        />
    );
}

function CodeBoxes({
    value,
    onValueChange,
    length = CODE_LENGTH,
    masked = false,
    autoSubmit = false,
    autoFocus = true,
    className,
    ref,
    disabled,
    readOnly,
    onFocus,
    onBlur,
    onKeyDown,
    onPaste,
    onClick,
    onSelect,
    style,
    ...props
}: Omit<CodeInputProps, "boxes">) {
    const words = useUiStrings();
    const input = useRef<HTMLInputElement | null>(null);
    const slots = useRef<(HTMLDivElement | null)[]>([]);
    const inserting = useRef(false);
    const emitted = useRef<string | null>(null);
    const [focused, setFocused] = useState(false);
    const [revealed, setRevealed] = useState(false);
    const [selection, setSelection] = useState<CodeSelection>([0, 0]);
    const code = codeDigits(value, length);

    const attach = useCallback(
        (node: HTMLInputElement | null) => {
            input.current = node;
            if (typeof ref === "function") ref(node);
            else if (ref) ref.current = node;
        },
        [ref]
    );

    /** Put the selection where it belongs for `filled` digits, now and again
     *  after React has put the value back - a refused character resets the
     *  element's value, which drops the caret at the end. */
    const place = useCallback(
        (start: number, end: number, filled: number) => {
            const [from, to] = settleSelection(start, end, filled, length, inserting.current);
            setSelection((shown) => (shown[0] === from && shown[1] === to ? shown : [from, to]));
            const apply = () => {
                const node = input.current;
                if (!node || node.ownerDocument.activeElement !== node) return;
                if (node.selectionStart !== from || node.selectionEnd !== to) node.setSelectionRange(from, to);
            };
            apply();
            queueMicrotask(apply);
        },
        [length]
    );

    // A value the caller replaced (cleared after a refusal) keeps the caret inside
    // it. One these boxes sent already has its caret placed.
    useLayoutEffect(() => {
        if (emitted.current === code) return;
        emitted.current = code;
        const node = input.current;
        if (!node || node.ownerDocument.activeElement !== node) return;
        const start = node.selectionStart ?? code.length;
        place(start, node.selectionEnd ?? start, code.length);
    }, [code, place]);

    const commit = (next: string, caret: number, node: HTMLInputElement) => {
        emitted.current = next;
        if (next !== code) onValueChange(next);
        place(caret, caret, next.length);
        if (autoSubmit && justCompleted(code, next, length)) submitOwnForm(node);
    };

    const fromSelection = (node: HTMLInputElement) => {
        const start = node.selectionStart ?? code.length;
        place(start, node.selectionEnd ?? start, code.length);
    };

    const invalid = props["aria-invalid"] === true || props["aria-invalid"] === "true";
    const many = length > 8;
    const [from, to] = selection;

    const cells: ReactNode[] = [];
    for (let index = 0; index < length; index += 1) {
        const digit = code[index] ?? "";
        const active = focused && (to - from > 1 ? index >= from && index < to : index === from);
        const caret = focused && from === to && index === from;
        cells.push(
            <div
                key={index}
                ref={(node) => {
                    slots.current[index] = node;
                }}
                data-slot={index}
                data-active={active || undefined}
                className={cn(
                    "relative flex h-full min-w-0 max-w-10 flex-1 basis-0 items-center justify-center rounded-md border bg-field text-base font-medium tabular-nums text-foreground transition-colors duration-fast",
                    invalid ? "border-danger" : "border-border",
                    active && (invalid ? "ring-1 ring-danger" : "border-primary ring-1 ring-primary")
                )}
            >
                {digit ? (masked && !revealed ? HIDDEN_DIGIT : digit) : null}
                {caret ? (
                    <span
                        aria-hidden
                        className={cn(
                            "pointer-events-none absolute h-1/2 w-px animate-pulse bg-foreground",
                            digit ? "start-1" : null
                        )}
                    />
                ) : null}
            </div>
        );
    }

    const field = (
        <div
            dir="ltr"
            className={cn(
                "relative flex h-10 w-full min-w-0 items-stretch",
                many ? "gap-1" : "gap-1.5",
                disabled && "cursor-not-allowed opacity-50",
                masked ? "flex-1" : className
            )}
        >
            {cells}
            <input
                inputMode="numeric"
                autoComplete={masked ? "off" : "one-time-code"}
                placeholder={exampleCode(length)}
                autoFocus={autoFocus}
                {...props}
                ref={attach}
                disabled={disabled}
                readOnly={readOnly}
                type={masked && !revealed ? "password" : "text"}
                value={code}
                spellCheck={false}
                autoCorrect="off"
                autoCapitalize="off"
                className="absolute inset-0 z-10 h-full w-full cursor-text border-0 bg-transparent p-0 font-mono text-base text-transparent caret-transparent outline-none placeholder:text-transparent selection:bg-transparent focus-visible:outline-none disabled:cursor-not-allowed"
                style={{ letterSpacing: "-0.5em", ...style }}
                onFocus={(event) => {
                    setFocused(true);
                    inserting.current = false;
                    place(code.length, code.length, code.length);
                    onFocus?.(event);
                }}
                onBlur={(event) => {
                    setFocused(false);
                    inserting.current = false;
                    onBlur?.(event);
                }}
                onSelect={(event) => {
                    fromSelection(event.currentTarget);
                    onSelect?.(event);
                }}
                onClick={(event) => {
                    const spans = slots.current.map((slot) => {
                        const box = slot?.getBoundingClientRect();
                        return [box?.left ?? 0, box?.right ?? 0] as const;
                    });
                    const at = slotAt(event.clientX, spans);
                    inserting.current = false;
                    place(at, at, code.length);
                    onClick?.(event);
                }}
                onKeyDown={(event) => {
                    onKeyDown?.(event);
                    if (event.defaultPrevented) return;
                    const { key } = event;
                    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
                    // A letter or a space never lands, so the caret never moves for it.
                    if (plain && key.length === 1 && !/\d/.test(key)) {
                        event.preventDefault();
                        return;
                    }
                    if (!plain || event.shiftKey) return;
                    const last = Math.min(code.length, length - 1);
                    const target =
                        key === "ArrowLeft" ? (to - from > 1 ? from : from - 1)
                            : key === "ArrowRight" ? (to - from > 1 ? to - 1 : from + 1)
                                : key === "Home" || key === "ArrowUp" ? 0
                                    : key === "End" || key === "ArrowDown" ? last
                                        : null;
                    if (target === null) return;
                    event.preventDefault();
                    inserting.current = false;
                    const at = Math.max(0, Math.min(target, last));
                    place(at, at, code.length);
                }}
                onPaste={(event) => {
                    onPaste?.(event);
                    if (event.defaultPrevented || readOnly || disabled) return;
                    event.preventDefault();
                    const node = event.currentTarget;
                    const pasted = pasteInto(code, node.selectionStart ?? from, node.selectionEnd ?? to, event.clipboardData.getData("text"), length);
                    if (!pasted) return;
                    inserting.current = false;
                    commit(pasted.value, pasted.caret, node);
                }}
                onChange={(event) => {
                    const node = event.currentTarget;
                    const raw = node.value;
                    const caret = node.selectionStart ?? raw.length;
                    if (raw.replace(/\D/g, "").length <= length) {
                        // Typing, deleting, select-all and type, a code autofilled into the empty boxes.
                        const next = codeDigits(raw, length);
                        const at = codeDigits(raw.slice(0, caret), length).length;
                        inserting.current = next.length < code.length && at < next.length;
                        commit(next, at, node);
                        return;
                    }
                    // More digits than the code holds: something was dropped in over
                    // what was there (an autofill, a paste the keyboard inserted itself).
                    const tail = raw.length - caret;
                    const start = sharedStart(raw.slice(0, caret), code);
                    const end = Math.max(start, code.length - tail);
                    const pasted = pasteInto(code, start, end, raw.slice(start, caret), length);
                    inserting.current = false;
                    if (pasted) commit(pasted.value, pasted.caret, node);
                    else place(caret, caret, code.length);
                }}
            />
        </div>
    );

    if (!masked) return field;

    return (
        <div className={cn("flex w-full min-w-0 items-center gap-1.5", className)}>
            {field}
            <button
                type="button"
                tabIndex={-1}
                disabled={disabled}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => setRevealed((shown) => !shown)}
                className="shrink-0 rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed"
                aria-label={revealed ? words.hidePassword : words.showPassword}
                title={revealed ? words.hidePassword : words.showPassword}
            >
                {revealed ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
        </div>
    );
}
