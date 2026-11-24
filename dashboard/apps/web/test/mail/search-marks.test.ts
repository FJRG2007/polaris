// @vitest-environment jsdom

/**
 * Marking a searched word in a message's body works on the sanitized tree, one
 * text node at a time: tags and attributes come out as they went in, and text
 * that looks like markup stays text.
 */

import { describe, expect, it } from "vitest";
import { markHtml } from "@/app/(app)/mail/search-marks";
import type { MailMessageView } from "@/lib/mailbox/views";
import { searchMatchIds } from "@/app/(app)/mail/search-matches";

describe("marking a body", () => {
    it("wraps the word in a mark and keeps the markup around it", () => {
        const out = markHtml('<p class="x">El <a href="https://a.test/">contrato</a> firmado</p>', [
            "contrato"
        ]);
        expect(out).toBe(
            '<p class="x">El <a href="https://a.test/"><mark data-search-hit="">contrato</mark></a> firmado</p>'
        );
    });

    it("never marks inside an attribute or a stylesheet", () => {
        const html = '<style>.contrato{color:red}</style><a title="contrato" href="#">x</a>';
        expect(markHtml(html, ["contrato"])).toBe(html);
    });

    it("keeps escaped markup in the text escaped", () => {
        const out = markHtml("<p>&lt;img src=x onerror=alert(1)&gt; contrato</p>", ["contrato"]);
        expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
        expect(out).not.toContain("<img");
        expect(out).toContain('<mark data-search-hit="">contrato</mark>');
    });

    it("matches across accents and leaves the text as written", () => {
        expect(markHtml("<p>La ACCIÓN</p>", ["accion"])).toBe(
            '<p>La <mark data-search-hit="">ACCIÓN</mark></p>'
        );
    });

    it("returns the HTML untouched when nothing matches or nothing was asked", () => {
        expect(markHtml("<p>hola</p>", ["adios"])).toBe("<p>hola</p>");
        expect(markHtml("<p>hola</p>", [])).toBe("<p>hola</p>");
    });
});

function message(id: string, subject: string, snippet: string): MailMessageView {
    return {
        id,
        subject,
        snippet,
        from: [{ name: "Ana", address: "ana@example.com" }],
        to: [],
        cc: []
    } as unknown as MailMessageView;
}

describe("which messages of an open conversation matched", () => {
    const listed = [message("a", "Hola", "nada"), message("b", "Re: Hola", "el contrato va")];

    it("takes the list row's answer when there is one, in the pane's order", () => {
        expect(searchMatchIds(listed, ["b", "a"], ["x"])).toEqual(["a", "b"]);
    });

    it("works it out from the previews when the row did not say", () => {
        expect(searchMatchIds(listed, undefined, ["contrato"])).toEqual(["b"]);
        expect(searchMatchIds(listed, undefined, ["ana"])).toEqual(["a", "b"]);
        expect(searchMatchIds(listed, undefined, [])).toEqual([]);
    });
});
