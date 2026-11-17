/**
 * The terminal's key bar on a phone: what each key sends, what Ctrl does to the
 * next typed key, and how far the on-screen keyboard reaches up the window.
 */

import { describe, expect, it } from "vitest";
import { barKeySequence, keyboardInset, withCtrl } from "@/lib/terminal-keys";

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
