// @vitest-environment jsdom

/**
 * Addresses a sender typed but did not link.
 *
 * Mail carries them as words all the time - a tracking page, a meeting, an
 * unsubscribe line - and left as words the reader has to select and copy them.
 *
 * The reason this walks the parsed document instead of running an expression
 * over the markup is the thing worth testing: a pattern loose enough to find an
 * address in a sentence is also loose enough to find one inside an href, a
 * style or a srcset, and rewriting the tag around it would break the message or
 * worse.
 */

import { describe, expect, it } from "vitest";
import { linkifyBareAddresses } from "@/app/(app)/mail/message-body";

describe("bare addresses in a message", () => {
    it("makes one into a link", () => {
        const out = linkifyBareAddresses("<p>Unirme con Google Meet https://meet.google.com/jpa-wmbv-szp</p>");
        expect(out).toContain('<a href="https://meet.google.com/jpa-wmbv-szp">https://meet.google.com/jpa-wmbv-szp</a>');
    });

    it("takes a www address to be one too", () => {
        const out = linkifyBareAddresses("<p>visita www.example.com hoy</p>");
        expect(out).toContain('<a href="https://www.example.com">www.example.com</a>');
    });

    it("leaves the full stop at the end of the sentence out of it", () => {
        const out = linkifyBareAddresses("<p>Ver https://example.com/pedido.</p>");
        expect(out).toContain('>https://example.com/pedido</a>.');
    });

    it("never touches an address that is already a link", () => {
        const markup = '<a href="https://example.com/x">https://example.com/x</a>';
        expect(linkifyBareAddresses(markup)).toBe(markup);
    });

    it("never rewrites an address inside an attribute", () => {
        // The whole reason this reads the document rather than the markup.
        const markup = '<img src="https://cdn.example/a.png" srcset="https://cdn.example/b.png 2x">';
        expect(linkifyBareAddresses(markup)).toBe(markup);
    });

    it("leaves a stylesheet alone", () => {
        const markup = "<style>.a{background:url(https://cdn.example/a.png)}</style><p>hola</p>";
        expect(linkifyBareAddresses(markup)).not.toContain("<a ");
    });

    it("does nothing at all to a message with no addresses in it", () => {
        const markup = "<p>Hola, nos vemos el martes.</p>";
        expect(linkifyBareAddresses(markup)).toBe(markup);
    });

    it("handles several in one line", () => {
        const out = linkifyBareAddresses("<p>a https://one.example b https://two.example c</p>");
        expect(out.split("<a ").length - 1).toBe(2);
        expect(out).toContain("a <a");
        expect(out).toContain(" b <a");
        expect(out).toContain(" c</p>");
    });
});
