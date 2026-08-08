import { describe, expect, it } from "vitest";
import { applyMotdCode, motdMap, replaceMotdPlain, stripMotd } from "@/lib/apps/minecraft/motd";

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

describe("applyMotdCode", () => {
    it("wraps the selection instead of replacing it", () => {
        // The bug this exists for: colouring a word used to delete the word.
        const result = applyMotdCode("Hello world", 6, 11, "a");
        expect(stripMotd(result.text)).toBe("Hello world");
        expect(result.text).toBe("Hello &aworld&r");
    });

    it("puts the surrounding colour back after the selection", () => {
        const result = applyMotdCode("&cHello world", 0, 5, "a");
        expect(result.text).toBe("&c&aHello&c world");
        expect(stripMotd(result.text)).toBe("Hello world");
    });

    it("restores a colour and its styles together", () => {
        const result = applyMotdCode("&c&lHello world", 6, 11, "a");
        expect(result.text).toBe("&c&lHello &aworld&c&l");
    });

    it("inserts at the caret when nothing is selected, applying from there on", () => {
        expect(applyMotdCode("Hello", 5, 5, "a").text).toBe("Hello&a");
    });

    it("needs nothing after it when the code is the reset itself", () => {
        expect(applyMotdCode("&cHello", 0, 5, "r").text).toBe("&c&rHello");
    });

    it("selects over a code without swallowing the text around it", () => {
        const result = applyMotdCode("&cred&agreen", 0, 8, "l");
        expect(stripMotd(result.text)).toBe("redgreen");
        expect(result.text.startsWith("&c&l")).toBe(true);
    });

    it("keeps the visible selection where it was", () => {
        const result = applyMotdCode("Hello world", 6, 11, "a");
        expect([result.start, result.end]).toEqual([6, 11]);
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
