/**
 * Email obfuscation rewrites the HTML a visitor is served, which makes it the one
 * firewall control that can break a working page rather than merely refuse a request.
 * So what is protected here is mostly what it must NOT touch: script bodies, comments,
 * attributes that are not an anchor's own mailto, and anything the operator fenced off
 * with the markers. The round trip is checked too - a token the decoder cannot read is
 * an address deleted from the page.
 */

import { describe, expect, it } from "vitest";
import {
    decodeObfuscatedEmail,
    encodeObfuscatedEmail,
    EMAIL_PROTECTION_PATH,
    obfuscateEmailsInHtml
} from "../src/waf-email.js";

/** A fixed key, so a token is the same string every run. */
const KEY = 0x2a;

function rewrite(html: string) {
    return obfuscateEmailsInHtml(html, { key: KEY });
}

describe("the encoding", () => {
    it("round-trips an address", () => {
        const token = encodeObfuscatedEmail("hola@ejemplo.com", KEY);

        expect(token.startsWith("2a")).toBe(true);
        expect(token).not.toContain("hola");
        expect(decodeObfuscatedEmail(token)).toBe("hola@ejemplo.com");
    });

    it("round-trips an address with non-ASCII characters", () => {
        const token = encodeObfuscatedEmail("josé@ejemplo.es", KEY);

        expect(decodeObfuscatedEmail(token)).toBe("josé@ejemplo.es");
    });

    it("carries the key, so any key decodes", () => {
        for (const key of [0x00, 0x01, 0x7f, 0xff]) {
            expect(decodeObfuscatedEmail(encodeObfuscatedEmail("a@b.io", key))).toBe("a@b.io");
        }
    });

    it("returns empty rather than throwing on a malformed token", () => {
        expect(decodeObfuscatedEmail("")).toBe("");
        expect(decodeObfuscatedEmail("zz")).toBe("");
        expect(decodeObfuscatedEmail("2a4")).toBe("");
    });
});

describe("what it rewrites", () => {
    it("hides a bare address in text", () => {
        const { html, replaced } = rewrite("<p>Write to hola@ejemplo.com today</p>");

        expect(replaced).toBe(1);
        expect(html).not.toContain("hola@ejemplo.com");
        expect(html).toContain("data-pemail=");
        // The visitor without JavaScript is left with something that reads as hidden,
        // not with a gap where the address was.
        expect(html).toContain("[email&#160;protected]");
    });

    it("rewrites a mailto href and keeps the link's text", () => {
        const { html, replaced } = rewrite('<a href="mailto:hola@ejemplo.com">contacto</a>');

        expect(replaced).toBe(1);
        expect(html).toContain(EMAIL_PROTECTION_PATH);
        expect(html).toContain("__polaris_email__");
        expect(html).toContain(">contacto</a>");
        expect(html).not.toContain("mailto:hola@ejemplo.com");
    });

    it("keeps a mailto's subject, so a contact link still carries one", () => {
        const { html } = rewrite('<a href="mailto:hola@ejemplo.com?subject=Hi">contacto</a>');
        const token = /#([0-9a-f]+)"/.exec(html)?.[1] ?? "";

        expect(decodeObfuscatedEmail(token)).toBe("hola@ejemplo.com?subject=Hi");
    });

    it("merges into an existing class attribute rather than adding a second one", () => {
        const { html } = rewrite('<a class="btn" href="mailto:a@b.io">x</a>');

        expect(html).toContain('class="btn __polaris_email__"');
        expect(html.match(/class=/g)).toHaveLength(1);
    });

    it("uses a fresh key per response, so one address is not a stable fingerprint", () => {
        const one = obfuscateEmailsInHtml("<p>a@b.io</p>", { key: 0x11 });
        const two = obfuscateEmailsInHtml("<p>a@b.io</p>", { key: 0x22 });

        expect(one.html).not.toBe(two.html);
    });
});

describe("what it leaves alone", () => {
    it("never touches a script body", () => {
        const source = '<script>var contact = "hola@ejemplo.com";</script>';

        expect(rewrite(source)).toEqual({ html: source, replaced: 0 });
    });

    it("never touches a style, template or textarea body", () => {
        for (const tag of ["style", "template", "textarea"]) {
            const source = `<${tag}>hola@ejemplo.com</${tag}>`;

            expect(rewrite(source).replaced).toBe(0);
        }
    });

    it("never touches an HTML comment", () => {
        const source = "<!-- reach us at hola@ejemplo.com -->";

        expect(rewrite(source)).toEqual({ html: source, replaced: 0 });
    });

    it("never touches an attribute that is not an anchor's mailto", () => {
        const source = '<img alt="hola@ejemplo.com" src="/x.png"><a href="/contact?to=a@b.io">c</a>';

        expect(rewrite(source)).toEqual({ html: source, replaced: 0 });
    });

    it("honours the off markers, and leaves them in the source", () => {
        const source = "<p><!--email_off-->hola@ejemplo.com<!--/email_off--></p>";
        const { html, replaced } = rewrite(source);

        expect(replaced).toBe(0);
        expect(html).toBe(source);
    });

    it("still rewrites outside the off markers", () => {
        const { html, replaced } = rewrite(
            "<p><!--email_off-->keep@me.io<!--/email_off--> and hide@me.io</p>"
        );

        expect(replaced).toBe(1);
        expect(html).toContain("keep@me.io");
        expect(html).not.toContain("hide@me.io");
    });

    it("leaves a page with no address exactly as it was", () => {
        const source = "<html><body><h1>Hello</h1></body></html>";

        expect(rewrite(source)).toEqual({ html: source, replaced: 0 });
    });

    it("emits unterminated markup unchanged rather than guessing at it", () => {
        const source = "<p>a@b.io</p><div class=";
        const { html } = rewrite(source);

        expect(html.endsWith("<div class=")).toBe(true);
    });

    it("does not lose content when an opaque tag never closes", () => {
        const { html, replaced } = rewrite("<p>a@b.io</p><script>var x = 1;");

        expect(replaced).toBe(1);
        expect(html).toContain("var x = 1;");
    });
});
