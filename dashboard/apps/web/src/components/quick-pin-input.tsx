"use client";

/**
 * The box the account's quick-unlock PIN is typed into, everywhere it is asked
 * for: the lock screen, a locked app, approving a sign-in.
 *
 * The PIN is 4 to 6 digits and the account knows which, so the box checks it
 * the moment the last digit lands, the way a phone's lock screen does. A PIN set
 * before its length was recorded has no known length until it is next typed
 * right, and until then it waits for the button like before. The button stays
 * either way.
 */

import type { Ref } from "react";
import type { InputProps } from "@polaris/ui";
import { CodeInput } from "@/components/code-input";

/** The bounds `setQuickPin` enforces. */
export const PIN_MIN = 4;
export const PIN_MAX = 6;

/** Whether what was typed is a PIN worth checking: exactly the known length,
 *  or anything within the bounds when the length is not known. */
export function pinReady(pin: string, length: number | null): boolean {
    if (length !== null) return pin.length === length;
    return pin.length >= PIN_MIN && pin.length <= PIN_MAX;
}

export function QuickPinInput({
    length,
    ...props
}: Omit<InputProps, "value" | "onChange" | "type" | "maxLength"> & {
    value: string;
    onValueChange: (value: string) => void;
    ref?: Ref<HTMLInputElement>;
    /** The PIN's length when the account knows it, null when it does not yet. */
    length: number | null;
}) {
    // An unknown length draws no placeholder: six zeros would claim one.
    return (
        <CodeInput
            masked
            autoSubmit={length !== null}
            length={length ?? PIN_MAX}
            {...(length === null ? { placeholder: "" } : {})}
            {...props}
        />
    );
}
