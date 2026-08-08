import { describe, expect, it } from "vitest";
import {
    applyMotdCode,
    isCenteredMotd,
    motdMap,
    replaceMotdPlain,
    stripMotd,
    toggleCenterMotd
} from "@/lib/apps/minecraft/motd";

describe("motdMap", () => {
    it("gives the text without its codes, and where each character came from", () => {
        const map = motdMap("&aHi");
        expect(map.plain).toBe("Hi");
        expect(map.offsets).toEqual([2, 3, 4]);
        expect(map.codes[0]).toEqual({ color: "a", styles: [] });
    });

    it("stacks a style on a colour and drops the styles when the colour changes", () => {
        const map = motdMap("&a&lBold&cRed");
        expect(map.plain).toBe("BoldRed");
        expect(map.codes[0]).toEqual({ color: "a", styles: ["l"] });
        expect(map.codes[4]).toEqual({ color: "c", styles: [] });
    });

    it("carries formatting across the line break, as the client does", () => {
        const map = motdMap("&aone\ntwo");
        expect(map.plain).toBe("one\ntwo");
        expect(map.codes[4]).toEqual({ color: "a", styles: [] });
    });
});

/** What is in force at each visible character, which is what the reader sees and
 *  the only thing worth asserting about a string full of markers. */
function formattingOf(raw: string): { color: string | null; styles: readonly string[] }[] {
    return [...motdMap(raw).codes].slice(0, motdMap(raw).plain.length);
}

describe("applyMotdCode", () => {
    it("formats the selection instead of replacing it", () => {
        // The bug this exists for: colouring a word used to delete the word.
        const result = applyMotdCode("Hello world", 6, 11, "a");
        expect(stripMotd(result.text)).toBe("Hello world");
        expect(formattingOf(result.text)[6]).toEqual({ color: "a", styles: [] });
    });

    it("leaves the text on either side of the selection as it was", () => {
        const result = applyMotdCode("&cHello world", 0, 5, "a");
        expect(stripMotd(result.text)).toBe("Hello world");
        expect(formattingOf(result.text)[0]?.color).toBe("a");
        expect(formattingOf(result.text)[6]?.color).toBe("c");
    });

    it("keeps a style under a colour, which the notation on its own does not", () => {
        const result = applyMotdCode("&c&lHello world", 6, 11, "a");
        expect(formattingOf(result.text)[6]).toEqual({ color: "a", styles: ["l"] });
        expect(formattingOf(result.text)[0]).toEqual({ color: "c", styles: ["l"] });
    });

    it("takes a style off a selection that already has it, everywhere", () => {
        const once = applyMotdCode("Hello world", 0, 11, "k");
        const twice = applyMotdCode(once.text, 0, 11, "k");
        expect(stripMotd(twice.text)).toBe("Hello world");
        expect(formattingOf(twice.text).every((codes) => codes.styles.length === 0)).toBe(true);
    });

    it("finishes a half-formatted selection rather than undoing it", () => {
        const part = applyMotdCode("Hello world", 0, 5, "l");
        const whole = applyMotdCode(part.text, 0, 11, "l");
        expect(formattingOf(whole.text).every((codes) => codes.styles.includes("l"))).toBe(true);
    });

    it("clears a colour when the same one is applied again", () => {
        const once = applyMotdCode("Hello", 0, 5, "a");
        const twice = applyMotdCode(once.text, 0, 5, "a");
        expect(stripMotd(twice.text)).toBe("Hello");
        expect(formattingOf(twice.text)[0]?.color).toBe(null);
    });

    it("takes a style off part of a run without touching the rest", () => {
        const bold = applyMotdCode("Hello world", 0, 11, "l");
        const half = applyMotdCode(bold.text, 6, 11, "l");
        expect(formattingOf(half.text)[0]?.styles).toEqual(["l"]);
        expect(formattingOf(half.text)[6]?.styles).toEqual([]);
        expect(stripMotd(half.text)).toBe("Hello world");
    });

    it("inserts at the caret when nothing is selected, applying from there on", () => {
        expect(applyMotdCode("Hello", 5, 5, "a").text).toBe("Hello&a");
    });

    it("switches a code back off at the caret when it is already in force", () => {
        // "&l" is on from here; pressing bold again has to stop it, not stack it.
        const result = applyMotdCode("&lHello", 5, 5, "l");
        expect(result.text).toBe("&lHello&r");
        expect(formattingOf(`${result.text}x`)[5]?.styles).toEqual([]);
    });

    it("clears everything under a reset", () => {
        const result = applyMotdCode("&c&lHello", 0, 5, "r");
        expect(stripMotd(result.text)).toBe("Hello");
        expect(formattingOf(result.text)[0]).toEqual({ color: null, styles: [] });
    });

    it("selects over a code without swallowing the text around it", () => {
        const result = applyMotdCode("&cred&agreen", 0, 8, "l");
        expect(stripMotd(result.text)).toBe("redgreen");
        expect(formattingOf(result.text)[0]).toEqual({ color: "c", styles: ["l"] });
        expect(formattingOf(result.text)[3]).toEqual({ color: "a", styles: ["l"] });
    });

    it("keeps the visible selection where it was", () => {
        const result = applyMotdCode("Hello world", 6, 11, "a");
        expect([result.start, result.end]).toEqual([6, 11]);
    });

    it("says no more than it has to", () => {
        // One code where something changes, none where nothing does.
        expect(applyMotdCode("Hello world", 0, 11, "a").text).toBe("&aHello world");
    });
});

describe("toggleCenterMotd", () => {
    it("centres lines that are against the left", () => {
        const centred = toggleCenterMotd("Hello");
        expect(centred.startsWith(" ")).toBe(true);
        expect(centred.trim()).toBe("Hello");
    });

    it("puts them back when they are already centred", () => {
        // The bug: pressing it twice used to leave the text where it was, with no
        // way back short of deleting the spaces by hand.
        const centred = toggleCenterMotd("Hello\nthere");
        expect(toggleCenterMotd(centred)).toBe("Hello\nthere");
    });

    it("settles rather than walking the text rightwards", () => {
        const once = toggleCenterMotd("Hello");
        expect(toggleCenterMotd(toggleCenterMotd(once))).toBe(once);
    });

    it("counts the codes as no width, since they draw none", () => {
        expect(isCenteredMotd(toggleCenterMotd("&aHello"))).toBe(true);
    });

    it("does not call text with no padding centred", () => {
        expect(isCenteredMotd("Hello")).toBe(false);
        expect(isCenteredMotd("")).toBe(false);
    });

    it("centres both lines, not just the first", () => {
        const centred = toggleCenterMotd("one\ntwo");
        expect(centred.split("\n").every((line) => line.startsWith(" "))).toBe(true);
    });
});

describe("replaceMotdPlain", () => {
    it("takes typing at the end and keeps the colour it is in", () => {
        expect(replaceMotdPlain("&aHi", "Hi!")).toBe("&aHi!");
    });

    it("takes typing in the middle of a coloured run", () => {
        expect(replaceMotdPlain("&aHello", "Heyllo")).toBe("&aHeyllo");
    });

    it("keeps the codes on either side of a deletion", () => {
        expect(replaceMotdPlain("&aone&ctwo", "onetwo".replace("two", ""))).toBe("&aone&c");
    });

    it("leaves the string alone when nothing changed", () => {
        expect(replaceMotdPlain("&aHi", "Hi")).toBe("&aHi");
    });

    it("survives clearing the whole thing", () => {
        expect(stripMotd(replaceMotdPlain("&aHello &cworld", ""))).toBe("");
    });

    it("keeps a second line's formatting when the first is edited", () => {
        const next = replaceMotdPlain("&aone\n&ctwo", "ONE\ntwo");
        expect(stripMotd(next)).toBe("ONE\ntwo");
        expect(next).toContain("&c");
    });
});
