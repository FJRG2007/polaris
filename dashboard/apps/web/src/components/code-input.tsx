"use client";

/**
 * The box a six-digit code is typed into: one Polaris sent, or one from an
 * authenticator app.
 *
 * Digits only, kept as they are typed or pasted, so "123 456" and "123-456" from
 * a message both land as the code and a letter never gets in. No `maxLength` on
 * the element on purpose: the browser truncates a paste before anything sees it,
 * which would cut "123 456" to "123 45". The six are enforced here instead.
 */

import { Input, type InputProps } from "@polaris/ui";

/** How many digits a code has. `otpCodeField` in `@polaris/core` is the rule. */
export const CODE_LENGTH = 6;

/** Only the digits of what was typed, at most a code's worth. */
export function codeDigits(typed: string): string {
    return typed.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

/** Whether a code box holds a whole code, which is when its submit may be pressed. */
export function isWholeCode(value: string): boolean {
    return value.length === CODE_LENGTH;
}

export function CodeInput({
    value,
    onValueChange,
    ...props
}: Omit<InputProps, "value" | "onChange" | "type" | "maxLength"> & {
    value: string;
    onValueChange: (value: string) => void;
}) {
    return (
        <Input
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder="000000"
            {...props}
            value={value}
            onChange={(event) => onValueChange(codeDigits(event.target.value))}
        />
    );
}
