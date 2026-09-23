"use client";

/**
 * A size, in whatever unit the person is thinking in.
 *
 * Every limit Polaris keeps is stored in one unit - megabytes for an upload
 * limit, bytes for a disk budget - and making somebody type in that unit is how a
 * four gigabyte limit gets entered as 4096 and a forty gigabyte one as 40960,
 * with nothing on screen to catch the missing digit. So the field is a number and
 * a unit, and the unit is a choice: what is stored never changes.
 *
 * It opens on the unit the current value reads best in, so a limit saved as
 * 4096 MB comes back as 4 GB rather than as the number somebody had to work out
 * once already. Changing the unit converts what is in the box rather than
 * reinterpreting it - 4 GB picked from MB is 4 GB, not 4 MB relabelled - because
 * the other behaviour is a silent factor of 1024 either way.
 */

import { cn } from "../lib/cn";
import { Input } from "./input";
import { Select } from "./select";
import { useEffect, useState } from "react";
import { convertSize, readableSize, unitsFrom, type SizeUnit } from "@polaris/core";

export interface SizeFieldProps {
    /** The value, in `stored`. */
    value: number;
    /** The unit the setting is kept in, and the unit `onChange` hands back. */
    stored: SizeUnit;
    /** Bounds, in `stored`, exactly as the setting itself is bounded. */
    min?: number;
    max?: number;
    disabled?: boolean;
    className?: string;
    "aria-label"?: string;
    /** The new value, in `stored`. Only called for a value inside the bounds, so
     *  a half-typed number never reaches the setting. */
    onChange: (value: number) => void;
}

export function SizeField({
    value,
    stored,
    min = 0,
    max = Number.MAX_SAFE_INTEGER,
    disabled,
    className,
    onChange,
    ...rest
}: SizeFieldProps) {
    const units = unitsFrom(stored);
    const [unit, setUnit] = useState<SizeUnit>(() => readableSize(value, stored).unit);
    const [text, setText] = useState(() => String(readableSize(value, stored).value));

    // The value can move underneath this - a form that loaded, a reset, another
    // field that changed it - and when it does the box follows. Only when it says
    // something different from what is in the box, so typing is never interrupted
    // by a re-render that rewrites the digits under the cursor.
    useEffect(() => {
        const shown = convertSize(Number(text), unit, stored);
        if (Number.isFinite(shown) && Math.abs(shown - value) < 1e-9) return;
        const best = readableSize(value, stored);
        setUnit(best.unit);
        setText(String(best.value));
        // `text` and `unit` are deliberately absent: this is about the value
        // arriving from outside, and including them would fight the typing.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [value, stored]);

    function announce(next: string, nextUnit: SizeUnit): void {
        const typed = Number(next);
        if (!Number.isFinite(typed)) return;
        const converted = convertSize(typed, nextUnit, stored);
        // A size that cannot be stored exactly - 1.5 KB into a setting kept in
        // whole KB - is rounded here rather than refused: the person asked for
        // about that much, and the alternative is a field that silently ignores
        // what they typed.
        const rounded = Math.round(converted);
        if (rounded < min || rounded > max) return;
        onChange(rounded);
    }

    return (
        <div className={cn("flex items-center gap-2", className)}>
            <Input
                type="number"
                inputMode="decimal"
                min={0}
                value={text}
                disabled={disabled}
                className="w-28"
                {...rest}
                onChange={(event) => {
                    setText(event.target.value);
                    announce(event.target.value, unit);
                }}
            />
            <Select
                value={unit}
                disabled={disabled}
                onValueChange={(next) => {
                    setUnit(next as SizeUnit);
                    announce(text, next as SizeUnit);
                }}
                options={units.map((entry) => ({ value: entry, label: entry }))}
                className="w-20"
                aria-label="Unit"
            />
        </div>
    );
}
