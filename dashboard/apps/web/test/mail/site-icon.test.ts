/**
 * The mark a site declares in its own head.
 *
 * `/favicon.ico` is a convention rather than a rule, and a site built as a
 * single page application very often answers it with its own 404 page: npm does
 * exactly that at both well-known paths and names its logo in the markup, on a
 * static host of its own. These check the reading of that markup, which is the
 * difference between npm's logo in a mailbox and its initials.
 */

import { describe, expect, it } from "vitest";
import { iconLinks } from "@/lib/mailbox/site-icon";

/** npm's own head, trimmed to the elements that matter and with its addresses
 *  kept: the logo is on a host that has nothing to do with the sending domain,
 *  which is the case a relative-only reader would miss. */
const NPM = `<!doctype html><html><head><title>npm</title>
<link rel="apple-touch-icon" sizes="180x180" href="https://static.example-npm.com/apple.png"/>
<link rel="icon" type="image/png" href="https://static.example-npm.com/32.png" sizes="32x32"/>
<link rel="icon" type="image/png" href="https://static.example-npm.com/192.png" sizes="192x192"/>
<link rel="icon" type="image/png" href="https://static.example-npm.com/16.png" sizes="16x16"/>
</head><body><link rel="icon" href="/decoy.png"></body></html>`;

describe("the icons a page names", () => {
    it("finds one on a host of its own", () => {
        const found = iconLinks(NPM, "https://www.npmjs.com/");
        expect(found[0]?.href).toBe("https://static.example-npm.com/apple.png");
    });

    it("prefers a mark big enough to draw over a 16-pixel glyph", () => {
        const found = iconLinks(NPM, "https://www.npmjs.com/");
        expect(found.map((link) => link.size)).toEqual([180, 192, 32]);
    });

    it("resolves a relative address against where the page was served", () => {
        // A bare domain that redirects to its www publishes hrefs that only
        // resolve against the destination.
        const found = iconLinks(
            `<head><link rel="icon" href="/static/logo.png" sizes="128x128"></head>`,
            "https://www.example.com/"
        );
        expect(found[0]?.href).toBe("https://www.example.com/static/logo.png");
    });

    it("reads an unquoted attribute and any order of them", () => {
        const found = iconLinks(
            `<head><link sizes=64x64 href='/a.png' rel="shortcut icon"></head>`,
            "https://example.com/"
        );
        expect(found[0]).toMatchObject({ href: "https://example.com/a.png", size: 64 });
    });

    it("gives an apple-touch-icon the size the convention gives it", () => {
        const found = iconLinks(
            `<head><link rel="apple-touch-icon" href="/touch.png"></head>`,
            "https://example.com/"
        );
        expect(found[0]?.size).toBe(180);
    });

    it("leaves a vector mark behind a raster one", () => {
        // An SVG is the same drawing at any size, so it is worth having - but a
        // browser only allowed to treat it as a picture cannot be relied on to
        // carry its colours, so it loses a tie.
        const found = iconLinks(
            `<head><link rel="icon" href="/logo.svg" type="image/svg+xml">
             <link rel="icon" href="/logo.png" sizes="128x128"></head>`,
            "https://example.com/"
        );
        expect(found[0]?.href).toBe("https://example.com/logo.png");
        expect(found[1]?.href).toBe("https://example.com/logo.svg");
    });

    it("ignores Safari's pinned-tab silhouette", () => {
        // A single-path mask meant to be recoloured, which draws as a black blob.
        expect(
            iconLinks(
                `<head><link rel="mask-icon" href="/pin.svg" color="#000"></head>`,
                "https://example.com/"
            )
        ).toEqual([]);
    });

    it("never offers an address nothing can be fetched from", () => {
        expect(
            iconLinks(
                `<head><link rel="icon" href="data:image/png;base64,AAAA"></head>`,
                "https://example.com/"
            )
        ).toEqual([]);
    });

    it("stops at the head, so a body full of links is not walked", () => {
        const found = iconLinks(NPM, "https://www.npmjs.com/");
        expect(found.some((link) => link.href.endsWith("/decoy.png"))).toBe(false);
    });

    it("asks for no more than three of them", () => {
        const many = Array.from(
            { length: 9 },
            (_, index) =>
                `<link rel="icon" href="/${index}.png" sizes="${(index + 1) * 16}x${(index + 1) * 16}">`
        ).join("");
        expect(iconLinks(`<head>${many}</head>`, "https://example.com/")).toHaveLength(3);
    });

    it("has nothing to offer for a page that names none", () => {
        expect(iconLinks("<head><title>nothing</title></head>", "https://example.com/")).toEqual(
            []
        );
    });
});
