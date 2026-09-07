/**
 * Finding the way out of a mailing list.
 *
 * The case that shapes this is the one the obvious implementation misses: a
 * Spanish newsletter whose link reads "haz clic aqui" and whose sentence is the
 * only thing that says what the link does.
 */

import { describe, expect, it } from "vitest";
import * as unsub from "./mailbox-unsubscribe.js";

describe("what the headers promise", () => {
    it("prefers a page over a mailbox", () => {
        // A mailto tells a sender the address is live and read, which is exactly
        // what somebody leaving a list does not want to confirm.
        const found = unsub.unsubscribeFromHeaders({
            "list-unsubscribe": "<mailto:leave@list.example>, <https://list.example/out?id=7>"
        });
        expect(found).toEqual({ url: "https://list.example/out?id=7", kind: "link", source: "header" });
    });

    it("says when it can be done without opening anything", () => {
        const found = unsub.unsubscribeFromHeaders({
            "list-unsubscribe": "<https://list.example/out?id=7>",
            "list-unsubscribe-post": "List-Unsubscribe=One-Click"
        });
        expect(found?.kind).toBe("one-click");
    });

    it("never claims one-click for a mailbox, which cannot be posted to", () => {
        const found = unsub.unsubscribeFromHeaders({
            "list-unsubscribe": "<mailto:leave@list.example>",
            "list-unsubscribe-post": "List-Unsubscribe=One-Click"
        });
        expect(found).toEqual({ url: "mailto:leave@list.example", kind: "mailto", source: "header" });
    });

    it("has no answer when the sender gave none", () => {
        expect(unsub.unsubscribeFromHeaders({})).toBeNull();
        expect(unsub.unsubscribeFromHeaders(null)).toBeNull();
    });
});

describe("what a message's own footer says", () => {
    it("reads the sentence when the link itself says nothing", () => {
        // The message this whole function exists for.
        const html = `
            <p>Si no quieres recibir correos informativos de EF, por favor
            <a href="https://ef.example/p/9f2">haz clic aqu&iacute;</a>.</p>
        `;
        expect(unsub.unsubscribeInBody(html)).toEqual({
            url: "https://ef.example/p/9f2",
            kind: "link",
            source: "body"
        });
    });

    it("reads the link when the link says it", () => {
        const html = '<a href="https://x.example/a">Unsubscribe</a>';
        expect(unsub.unsubscribeInBody(html)?.url).toBe("https://x.example/a");
    });

    it("does not need the accents to be typed", () => {
        const html = '<a href="https://x.example/a">Cancelar suscripci&oacute;n</a>';
        expect(unsub.unsubscribeInBody(html)?.url).toBe("https://x.example/a");
        expect(unsub.unsubscribeInBody('<a href="https://y.example">Se d&eacute;sabonner</a>')?.url).toBe(
            "https://y.example"
        );
    });

    it("reads the address when neither the link nor the sentence says anything", () => {
        const html = '<a href="https://mail.example/unsubscribe/abc">Click here</a>';
        expect(unsub.unsubscribeInBody(html)?.url).toBe("https://mail.example/unsubscribe/abc");
    });

    it("prefers the link that says so itself over one whose neighbourhood does", () => {
        const html = `
            <p>Para dejar de recibir esto, visita <a href="https://a.example/help">nuestra ayuda</a>
            o bien <a href="https://a.example/unsubscribe">darse de baja</a>.</p>
        `;
        expect(unsub.unsubscribeInBody(html)?.url).toBe("https://a.example/unsubscribe");
    });

    it("finds the address under the sentence in a message with no markup", () => {
        const plain = [
            "Gracias por leernos.",
            "",
            "Si no deseas recibir mas correos:",
            "https://boletin.example/baja?u=44",
            ""
        ].join("\n");
        expect(unsub.unsubscribeInBody("", plain)).toEqual({
            url: "https://boletin.example/baja?u=44",
            kind: "link",
            source: "body"
        });
    });

    it("says nothing about a message that is not a mailing list", () => {
        const html = '<p>Hola, te paso el <a href="https://drive.example/doc">documento</a>.</p>';
        expect(unsub.unsubscribeInBody(html)).toBeNull();
    });

    it("ignores an anchor that goes nowhere", () => {
        expect(unsub.unsubscribeInBody('<a href="#">Unsubscribe</a>')).toBeNull();
        expect(unsub.unsubscribeInBody('<a href="javascript:void(0)">Unsubscribe</a>')).toBeNull();
    });
});

describe("both together", () => {
    it("trusts the header over the footer", () => {
        const found = unsub.unsubscribeOffer(
            { "list-unsubscribe": "<https://header.example/out>" },
            '<a href="https://body.example/unsubscribe">Unsubscribe</a>'
        );
        expect(found?.url).toBe("https://header.example/out");
        expect(found?.source).toBe("header");
    });

    it("falls to the footer when there is no header", () => {
        const found = unsub.unsubscribeOffer({}, '<a href="https://body.example/unsubscribe">Unsubscribe</a>');
        expect(found?.source).toBe("body");
    });
});
