"use client";

/**
 * A whole number between two bounds, held to them when the field is left rather
 * than on every key: clamped as it is typed, the first digit of "15" in a field
 * that starts at 2 would already have become 2.
 */

import { useState } from "react";
import { Input, type InputProps } from "@polaris/ui";

export function WholeNumberInput({
    value,
    min,
    max,
    onValueChange,
    ...props
}: Omit<InputProps, "value" | "min" | "max" | "onChange" | "type"> & {
    value: number;
    min: number;
    max: number;
    onValueChange: (value: number) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const commit = () => {
        if (draft === null) return;
        setDraft(null);
        const typed = Math.round(Number(draft));
        if (draft.trim() === "" || !Number.isFinite(typed)) return;
        const next = Math.min(max, Math.max(min, typed));
        if (next !== value) onValueChange(next);
    };
    return (
        <Input
            {...props}
            type="number"
            inputMode="numeric"
            min={min}
            max={max}
            value={draft ?? value}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={(event) => {
                commit();
                props.onBlur?.(event);
            }}
            onKeyDown={(event) => {
                if (event.key === "Enter") commit();
                props.onKeyDown?.(event);
            }}
        />
    );
}
