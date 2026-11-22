/**
 * The terminal's key bar on a phone: what each key sends, what Ctrl does to the
 * next typed key, and how far the on-screen keyboard reaches up the window.
 */

import { describe, expect, it } from "vitest";
import {
    POLAR_LINES,
    barKeyFace,
    barKeySequence,
    clipboardShortcut,
    isMacPlatform,
    keyboardInset,
    parseTerminalLayout,
    terminalExcerpt,
    withCtrl,
    withModifiers
} from "@/lib/terminal-keys";

describe("barKeySequence", () => {
    it("sends Escape and Tab as themselves", () => {
        expect(barKeySequence("esc", false)).toBe("\u001b");
        expect(barKeySequence("tab", false)).toBe("\t");
    });

    it("sends the arrows as cursor keys, and Ctrl+arrow as xterm's modified form", () => {
        expect(barKeySequence("up", false)).toBe("\u001b[A");
        expect(barKeySequence("down", false)).toBe("\u001b[B");
        expect(barKeySequence("right", false)).toBe("\u001b[C");
        expect(barKeySequence("left", false)).toBe("\u001b[D");
        expect(barKeySequence("left", true)).toBe("\u001b[1;5D");
    });

    it("sends nothing for Ctrl itself", () => {
        expect(barKeySequence("ctrl", false)).toBe("");
    });
});

describe("withCtrl", () => {
    it("turns a letter into its control code, either case", () => {
        expect(withCtrl("c")).toBe("\u0003");
        expect(withCtrl("C")).toBe("\u0003");
        expect(withCtrl("d")).toBe("\u0004");
        expect(withCtrl("z")).toBe("\u001a");
    });

    it("maps the punctuation that has one", () => {
        expect(withCtrl("[")).toBe("\u001b");
        expect(withCtrl(" ")).toBe("\u0000");
        expect(withCtrl("?")).toBe("\u007f");
    });

    it("changes only the first character", () => {
        expect(withCtrl("cat")).toBe("\u0003at");
    });

    it("leaves a character with no control code, and nothing, alone", () => {
        expect(withCtrl("1")).toBe("1");
        expect(withCtrl("")).toBe("");
    });
});

describe("keyboardInset", () => {
    it("is zero with no keyboard", () => {
        expect(keyboardInset(740, 740, 0)).toBe(0);
    });

    it("is the covered height with one", () => {
        expect(keyboardInset(740, 420, 0)).toBe(320);
        expect(keyboardInset(740, 420, 20.4)).toBe(300);
    });

    it("never goes negative", () => {
        expect(keyboardInset(740, 760, 0)).toBe(0);
    });
});

describe("the extra keys", () => {
    it("types the shell's symbols and sends the common control keys", () => {
        expect(barKeySequence("pipe", false)).toBe("|");
        expect(barKeySequence("tilde", false)).toBe("~");
        expect(barKeySequence("slash", false)).toBe("/");
        expect(barKeySequence("dash", false)).toBe("-");
        expect(barKeySequence("ctrlC", false)).toBe("\u0003");
        expect(barKeySequence("ctrlD", false)).toBe("\u0004");
        expect(barKeySequence("ctrlL", false)).toBe("\u000c");
        expect(barKeyFace("ctrlC")).toBe("^C");
        expect(barKeyFace("pipe")).toBe("|");
        expect(barKeyFace("up")).toBeNull();
    });

    it("sends Alt as the Escape prefix, and modified arrows in xterm's form", () => {
        expect(barKeySequence("alt", false)).toBe("");
        expect(barKeySequence("left", false, true)).toBe("\u001b[1;3D");
        expect(barKeySequence("left", true, true)).toBe("\u001b[1;7D");
        expect(barKeySequence("dash", false, true)).toBe("\u001b-");
        expect(withModifiers("b", false, true)).toBe("\u001bb");
        expect(withModifiers("c", true, false)).toBe("\u0003");
        expect(withModifiers("x", true, true)).toBe("\u001b\u0018");
        expect(withModifiers("x", false, false)).toBe("x");
    });
});

describe("clipboardShortcut", () => {
    const key = (k: string, mods: Partial<Record<"ctrlKey" | "shiftKey" | "altKey" | "metaKey", boolean>> = {}, type = "keydown") => ({
        type,
        key: k,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ...mods
    });

    it("copies on Ctrl+C with a selection, and leaves it as the interrupt without one", () => {
        expect(clipboardShortcut(key("c", { ctrlKey: true }), true, false)).toBe("copy");
        expect(clipboardShortcut(key("c", { ctrlKey: true }), false, false)).toBeNull();
    });

    it("always copies and pastes on Ctrl+Shift+C and Ctrl+Shift+V, whatever the case reports", () => {
        expect(clipboardShortcut(key("C", { ctrlKey: true, shiftKey: true }), false, false)).toBe("copy");
        expect(clipboardShortcut(key("V", { ctrlKey: true, shiftKey: true }), false, false)).toBe("paste");
    });

    it("pastes on Ctrl+V and Shift+Insert, copies on Ctrl+Insert", () => {
        expect(clipboardShortcut(key("v", { ctrlKey: true }), false, false)).toBe("paste");
        expect(clipboardShortcut(key("Insert", { shiftKey: true }), false, false)).toBe("paste");
        expect(clipboardShortcut(key("Insert", { ctrlKey: true }), true, false)).toBe("copy");
        expect(clipboardShortcut(key("Insert", { ctrlKey: true }), false, false)).toBeNull();
    });

    it("uses Cmd on a Mac, where Ctrl+C is always the interrupt", () => {
        expect(clipboardShortcut(key("c", { metaKey: true }), true, true)).toBe("copy");
        expect(clipboardShortcut(key("v", { metaKey: true }), false, true)).toBe("paste");
        expect(clipboardShortcut(key("c", { ctrlKey: true }), true, true)).toBeNull();
        expect(clipboardShortcut(key("v", { ctrlKey: true }), false, true)).toBeNull();
    });

    it("leaves every other key, Alt chords, and key releases to the terminal", () => {
        expect(clipboardShortcut(key("d", { ctrlKey: true }), true, false)).toBeNull();
        expect(clipboardShortcut(key("c"), true, false)).toBeNull();
        expect(clipboardShortcut(key("v", { ctrlKey: true, altKey: true }), false, false)).toBeNull();
        expect(clipboardShortcut(key("v", { ctrlKey: true }, "keyup"), false, false)).toBeNull();
        expect(clipboardShortcut(key("v", { metaKey: true }), false, false)).toBeNull();
    });

    it("tells a Mac from everything else", () => {
        expect(isMacPlatform("MacIntel")).toBe(true);
        expect(isMacPlatform("iPhone")).toBe(true);
        expect(isMacPlatform("Win32")).toBe(false);
        expect(isMacPlatform("Linux x86_64")).toBe(false);
    });
});

describe("terminalExcerpt", () => {
    it("prefers the selection, its line ends trimmed", () => {
        expect(terminalExcerpt(["a", "b"], "  error: x   \r\nline 2  ", 4000)).toEqual({
            text: "error: x\nline 2",
            source: "selection"
        });
    });

    it("takes only the last lines of output, dropping trailing blank rows", () => {
        const lines = Array.from({ length: POLAR_LINES + 50 }, (_, i) => `line ${i}`);
        const excerpt = terminalExcerpt([...lines, "", "   "], "", 1_000_000);
        const sent = excerpt!.text.split("\n");
        expect(excerpt!.source).toBe("output");
        expect(sent).toHaveLength(POLAR_LINES);
        expect(sent[sent.length - 1]).toBe(`line ${POLAR_LINES + 49}`);
    });

    it("cuts from the start at a line break, so the newest lines survive the cap", () => {
        const lines = Array.from({ length: 100 }, (_, i) => `row ${String(i).padStart(3, "0")} ${"x".repeat(40)}`);
        const excerpt = terminalExcerpt(lines, "", 500)!;
        expect(excerpt.text.length).toBeLessThanOrEqual(500);
        expect(excerpt.text.startsWith("row ")).toBe(true);
        expect(excerpt.text.endsWith(lines[99]!)).toBe(true);
    });

    it("has nothing to send for an empty terminal", () => {
        expect(terminalExcerpt([], "", 4000)).toBeNull();
        expect(terminalExcerpt(["", "  "], "   ", 4000)).toBeNull();
    });
});

describe("parseTerminalLayout", () => {
    it("reads back what was stored and defaults anything unreadable", () => {
        expect(parseTerminalLayout('{"maximized":true,"keys":false}')).toEqual({ maximized: true, keys: false });
        expect(parseTerminalLayout('{"maximized":"yes","keys":1}')).toEqual({ maximized: false, keys: null });
        expect(parseTerminalLayout("not json")).toEqual({ maximized: false, keys: null });
        expect(parseTerminalLayout(null)).toEqual({ maximized: false, keys: null });
    });
});
