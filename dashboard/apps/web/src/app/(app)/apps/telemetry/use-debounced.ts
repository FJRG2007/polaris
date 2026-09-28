"use client";

import { useEffect, useState } from "react";

/**
 * A value that follows another once it has stopped changing for `ms`.
 *
 * The search box feeds the list's read, and read straight from the field it
 * asked the server once per keystroke - six reads for "crash " with only the
 * last one ever shown. The field itself stays on the raw value, so typing is
 * never held back; only the read waits.
 */
export function useDebounced<T>(value: T, ms: number): T {
    const [settled, setSettled] = useState(value);
    useEffect(() => {
        const timer = setTimeout(() => setSettled(value), ms);
        return () => clearTimeout(timer);
    }, [value, ms]);
    return settled;
}
