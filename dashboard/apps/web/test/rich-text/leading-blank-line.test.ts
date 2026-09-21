/**
 * The line a reply opens on.
 *
 * A reply arrives holding the message it answers, and the composer used to open
 * on the first line of it: the attribution of somebody else's mail, with nowhere
 * to write. Every reply began with making room by hand.
 *
 * The line cannot be part of the value - Markdown has no blank paragraph, and
 * the serializer drops one rather than pretending otherwise - so it is put into
 * the document when the editor is opened. Which makes two things worth pinning:
 * that it is there, and that it changes nothing about what is stored or sent.
 */

import { describe, expect, it } from "vitest";
import { quoteForReply } from "@polaris/core";
import {
    docToMarkdown,
    markdownToDoc,
    withLeadingBlankLine
} from "../../src/components/rich-text/markdown";

/** What the composer is seeded with when somebody answers a message. */
const REPLY = `\n\n${quoteForReply(
    "Hola Javier,\n\nLa ventana escalonada nos va bien.",
    { name: "Albert Kampde", address: "albert@example.com" },
    new Date("2026-09-21T09:12:00Z")
)}`;

describe("opening a reply", () => {
    it("puts a line to write on above the message being answered", () => {
        const doc = withLeadingBlankLine(markdownToDoc(REPLY));

        const first = doc.content?.[0];
        expect(first?.type).toBe("paragraph");
        expect(first?.content ?? []).toEqual([]);
        // And the quote is still the thing under it, rather than something the
        // blank line replaced.
        expect(docToMarkdown(doc)).toContain("Albert Kampde");
    });

    // The editor decides whether to put the document back by comparing what it
    // holds against the value it was given. A line that changed that comparison
    // would be re-inserted on every render, taking the caret with it.
    it("costs the stored message nothing", () => {
        const plain = markdownToDoc(REPLY);

        expect(docToMarkdown(withLeadingBlankLine(plain))).toBe(docToMarkdown(plain));
    });

    it("leaves a document that already opens on an empty line alone", () => {
        const empty = markdownToDoc("");

        expect(withLeadingBlankLine(empty)).toEqual(empty);
        // Which is what keeps a new message from opening two lines down.
        expect(withLeadingBlankLine(empty).content).toHaveLength(1);
    });

    it("puts the writer above their own signature on a new message", () => {
        const doc = withLeadingBlankLine(markdownToDoc("-- \nJavier"));

        expect(doc.content?.[0]?.content ?? []).toEqual([]);
        expect(doc.content).toHaveLength(2);
    });
});
