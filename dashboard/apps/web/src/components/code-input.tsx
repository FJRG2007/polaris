"use client";

/**
 * The box a code of a known number of digits is typed into: one Polaris sent,
 * one from an authenticator app, or a chat lock code.
 *
 * Digits only, kept as they are typed or pasted, so "123 456" and "123-456" from
 * a message both land as the code and a letter never gets in. No `maxLength` on
 * the element on purpose: the browser truncates a paste before anything sees it,
 * which would cut "123 456" to "123 45". The length is enforced here instead.
 *
 * With `autoSubmit`, the box submits its form the moment the last digit lands,
 * so nobody has to reach for the button. Only where the code is the last thing
 * the form asks for: a form with another field after it waits for its button.
 */

import { Input, type InputProps } from "@polaris/ui";

/** How many digits a code has. `otpCodeField` in `@polaris/core` is the rule. */
export const CODE_LENGTH = 6;

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

export function CodeInput({
    value,
    onValueChange,
    length = CODE_LENGTH,
    masked = false,
    autoSubmit = false,
    ...props
}: Omit<InputProps, "value" | "onChange" | "type" | "maxLength"> & {
    value: string;
    onValueChange: (value: string) => void;
    /** How many digits the code has. */
    length?: number;
    /** Drawn as dots, with the show/hide toggle - for a code that is a secret. */
    masked?: boolean;
    /** Submit the form once the last digit is typed. */
    autoSubmit?: boolean;
}) {
    return (
        <Input
            inputMode="numeric"
            autoComplete={masked ? "off" : "one-time-code"}
            placeholder={"0".repeat(length)}
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
