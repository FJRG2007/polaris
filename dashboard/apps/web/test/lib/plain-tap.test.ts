import type { MouseEvent } from "react";
import { plainTap } from "@/lib/plain-tap";
import { afterEach, describe, expect, it, vi } from "vitest";

function event(type: string, pointerType?: string, shiftKey = false): MouseEvent {
    return { type, shiftKey, ctrlKey: false, metaKey: false, nativeEvent: { pointerType } } as never;
}

afterEach(() => vi.unstubAllGlobals());

describe("plainTap", () => {
    it("reads a click's own pointer", () => {
        expect(plainTap(event("click", "touch"))).toBe(true);
        expect(plainTap(event("click", "mouse"))).toBe(false);
        expect(plainTap(event("click", ""))).toBe(false);
    });

    it("does not take a modified click for a tap", () => {
        expect(plainTap(event("click", "touch", true))).toBe(false);
    });

    it("falls back to the screen when a click names no pointer", () => {
        vi.stubGlobal("matchMedia", () => ({ matches: true }));
        expect(plainTap(event("click"))).toBe(true);
        vi.stubGlobal("matchMedia", () => ({ matches: false }));
        expect(plainTap(event("click"))).toBe(false);
    });

    it("follows the click before a double click, whatever the screen is", () => {
        vi.stubGlobal("matchMedia", () => ({ matches: true }));
        plainTap(event("click", "mouse"));
        expect(plainTap(event("dblclick"))).toBe(false);
        vi.stubGlobal("matchMedia", () => ({ matches: false }));
        plainTap(event("click", "touch"));
        expect(plainTap(event("dblclick"))).toBe(true);
    });
});
