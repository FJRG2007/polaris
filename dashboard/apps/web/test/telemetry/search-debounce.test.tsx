// @vitest-environment jsdom

/**
 * The fault search waits for the typing to stop before it reads.
 *
 * Read straight from the field it asked the server once per keystroke, and only
 * the last answer was ever shown. The field follows every key; the read follows
 * the value once it has held still for a quarter of a second.
 */

import { useDebounced } from "@/app/(app)/apps/telemetry/use-debounced";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
    cleanup();
    vi.useRealTimers();
});

describe("the debounced search", () => {
    it("starts on the value it was given, with nothing to wait for", () => {
        const { result } = renderHook(() => useDebounced("", 250));
        expect(result.current).toBe("");
    });

    it("settles once, on the last value, after the typing stops", () => {
        const { result, rerender } = renderHook(({ value }) => useDebounced(value, 250), {
            initialProps: { value: "" }
        });
        for (const value of ["c", "cr", "cra", "cras", "crash"]) {
            rerender({ value });
            act(() => vi.advanceTimersByTime(100));
            expect(result.current).toBe("");
        }
        act(() => vi.advanceTimersByTime(149));
        expect(result.current).toBe("");
        act(() => vi.advanceTimersByTime(1));
        expect(result.current).toBe("crash");
    });
});
