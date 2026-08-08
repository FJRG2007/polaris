/**
 * The message of the day, and the codes Minecraft renders it with.
 *
 * The whole point of the editor is that a MOTD cannot be read off its source: a
 * colour silently clears bold, formatting carries across the line break, and the
 * file wants an escape no keyboard types. So what is pinned here is the behaviour
 * an operator would otherwise only discover by saving, restarting, and going to
 * look at the server list.
 */

import { describe, expect, it } from "vitest";
import {
    centerMotd,
    decodeMotd,
    encodeMotd,
    MOTD_COLORS,
    motdLineWidth,
    motdSpans,
    stripMotd
} from "@/lib/apps/minecraft/motd";

describe("motdSpans", () => {
    it("splits a line into the runs a client would draw", () => {
        const [line] = motdSpans("Plain &cRed");
        expect(line?.map((span) => [span.text, span.color])).toEqual([
            ["Plain ", MOTD_COLORS.f.hex],
            ["Red", MOTD_COLORS.c.hex]
        ]);
    });

    // Minecraft's rule and the one that catches people out: a colour is not a
    // paint change, it clears the styles with it.
    it("drops the styles when a colour follows them", () => {
        const [line] = motdSpans("&lBold &cRed");
        expect(line?.[0]).toMatchObject({ text: "Bold ", bold: true });
        expect(line?.[1]).toMatchObject({ text: "Red", bold: false, color: MOTD_COLORS.c.hex });
    });

    it("stacks a style on top of a colour", () => {
        const [line] = motdSpans("&c&lLoud");
        expect(line?.[0]).toMatchObject({ text: "Loud", bold: true, color: MOTD_COLORS.c.hex });
    });

    // The stored value is one string with a break in it, and nothing resets at the
    // break - so a second line typed on its own does not render on its own.
    it("carries formatting from the first line into the second", () => {
        const [, second] = motdSpans("&cFirst\nSecond");
        expect(second?.[0]).toMatchObject({ text: "Second", color: MOTD_COLORS.c.hex });
    });

    it("clears everything on a reset", () => {
        const [line] = motdSpans("&c&lLoud&r quiet");
        expect(line?.[1]).toMatchObject({ text: " quiet", bold: false, color: MOTD_COLORS.f.hex });
    });

    it("leaves an ampersand that is not a code as text", () => {
        expect(stripMotd("Bed & breakfast")).toBe("Bed & breakfast");
    });

    it("reads the section sign a pasted MOTD arrives with", () => {
        const [line] = motdSpans("§aGreen");
        expect(line?.[0]).toMatchObject({ text: "Green", color: MOTD_COLORS.a.hex });
    });

    // The client draws two and drops the rest, so the editor must not preview a
    // third line that nobody will ever see.
    it("shows only the two lines the client draws", () => {
        expect(motdSpans("one\ntwo\nthree")).toHaveLength(2);
    });
});

describe("encodeMotd", () => {
    // A real newline would end the property and lose the second line, so the break
    // goes in as the two characters the image's entrypoint expands.
    it("writes the section sign and keeps the break as an escape", () => {
        expect(encodeMotd("A server\n&4Line two")).toBe("A server\\n§4Line two");
    });

    it("round-trips back into what the editor shows", () => {
        const typed = "&aHello\n&4World";
        expect(decodeMotd(encodeMotd(typed))).toBe(typed);
    });

    // Pasting the output of any MOTD generator on the web is the obvious thing to
    // do with this field, and they emit the Java escape.
    it("reads a pasted value that used the unicode escape", () => {
        expect(decodeMotd("A server\\n\\u00A74Line two")).toBe("A server\n&4Line two");
    });
});

describe("centerMotd", () => {
    // Not padding to a character count: the font is not fixed width, so this is
    // the difference between centred in the editor and off to one side in game.
    it("pads by pixel width, not character count", () => {
        const centered = centerMotd("iii");
        const padding = centered.length - centered.replace(/^ +/, "").length;
        const wide = centerMotd("mmm");
        const widePadding = wide.length - wide.replace(/^ +/, "").length;
        expect(padding).toBeGreaterThan(widePadding);
    });

    it("does not walk the text rightwards when applied twice", () => {
        const once = centerMotd("A Minecraft server");
        expect(centerMotd(once)).toBe(once);
    });

    it("leaves a line that already overflows alone", () => {
        const long = "m".repeat(80);
        expect(centerMotd(long)).toBe(long);
    });

    it("ignores the codes, which draw nothing", () => {
        expect(motdLineWidth("&cabc")).toBe(motdLineWidth("abc"));
    });

    it("counts a bold run as the wider glyphs it is", () => {
        expect(motdLineWidth("&labc")).toBeGreaterThan(motdLineWidth("abc"));
    });
});
