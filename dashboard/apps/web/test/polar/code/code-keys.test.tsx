// @vitest-environment jsdom
import { describe, expect, it, vi, afterEach } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
    codeHasKeyboard,
    neighbourSession,
    STOP_AGAIN_MS,
    typingIn,
    useStopTwice
} from "@/components/polar/polar-code-keys";

const press = (target: EventTarget, key: string, held: { ctrl?: boolean; alt?: boolean } = {}) => ({
    target,
    key,
    ctrlKey: held.ctrl ?? false,
    metaKey: false,
    altKey: held.alt ?? false
});

describe("whether Code has the keyboard", () => {
    const root = document.createElement("div");
    const box = document.createElement("textarea");
    const button = document.createElement("button");
    root.append(box, button);
    document.body.append(root);
    const outside = document.createElement("input");
    document.body.append(outside);

    it("takes a plain key on a button in the view, not one typed in the composer", () => {
        expect(codeHasKeyboard(press(button, "i"), root, false)).toBe(true);
        expect(codeHasKeyboard(press(box, "i"), root, false)).toBe(false);
        expect(codeHasKeyboard(press(box, "?"), root, false)).toBe(false);
    });

    it("takes Alt, Ctrl and Escape in the composer", () => {
        expect(codeHasKeyboard(press(box, "n", { alt: true }), root, false)).toBe(true);
        expect(codeHasKeyboard(press(box, "/", { ctrl: true }), root, false)).toBe(true);
        expect(codeHasKeyboard(press(box, "Escape"), root, false)).toBe(true);
    });

    it("leaves a press elsewhere on the page alone, and the page itself only on Polar's own page", () => {
        expect(codeHasKeyboard(press(outside, "n", { alt: true }), root, true)).toBe(false);
        expect(codeHasKeyboard(press(document.body, "?"), root, false)).toBe(false);
        expect(codeHasKeyboard(press(document.body, "?"), root, true)).toBe(true);
        expect(codeHasKeyboard(press(button, "?"), null, false)).toBe(false);
    });

    it("counts editable text as typing", () => {
        const editable = document.createElement("div");
        editable.contentEditable = "true";
        // jsdom does not compute isContentEditable from the attribute.
        Object.defineProperty(editable, "isContentEditable", { value: true });
        expect(typingIn(editable)).toBe(true);
        expect(typingIn(button)).toBe(false);
        expect(typingIn(null)).toBe(false);
    });
});

describe("the two-press stop", () => {
    afterEach(() => vi.useRealTimers());

    it("arms on the first Escape and stops on the second", () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useStopTwice());
        let stopped = true;
        act(() => {
            stopped = result.current.press();
        });
        expect(stopped).toBe(false);
        expect(result.current.armed).toBe(true);
        act(() => {
            stopped = result.current.press();
        });
        expect(stopped).toBe(true);
        expect(result.current.armed).toBe(false);
    });

    it("lapses, so a second Escape much later only arms again", () => {
        vi.useFakeTimers();
        const { result } = renderHook(() => useStopTwice());
        act(() => void result.current.press());
        act(() => vi.advanceTimersByTime(STOP_AGAIN_MS + 1));
        expect(result.current.armed).toBe(false);
        let stopped = true;
        act(() => {
            stopped = result.current.press();
        });
        expect(stopped).toBe(false);
    });
});

describe("the next and previous session", () => {
    const ids = ["a", "b", "c"];

    it("steps through the history and stops at its ends", () => {
        expect(neighbourSession(ids, "b", 1)).toBe("c");
        expect(neighbourSession(ids, "b", -1)).toBe("a");
        expect(neighbourSession(ids, "c", 1)).toBeNull();
        expect(neighbourSession(ids, "a", -1)).toBeNull();
    });

    it("goes from a new task to the newest session, and from a session not listed to the first", () => {
        expect(neighbourSession(ids, null, 1)).toBe("a");
        expect(neighbourSession(ids, null, -1)).toBeNull();
        expect(neighbourSession(ids, "gone", 1)).toBe("a");
        expect(neighbourSession([], "a", 1)).toBeNull();
    });
});
