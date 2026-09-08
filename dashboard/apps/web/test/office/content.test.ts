/**
 * What a document is stored as, and what the list reads off it.
 *
 * The content of every Office document is a Yjs update rather than a document
 * format, which is what will let several people type at once. A CRDT is not
 * readable, though, so an excerpt is written beside it - and that excerpt is the
 * only thing search and the list have to go on.
 *
 * Two failures are pinned here. One is silent and permanent: a round trip that
 * loses content means a document that reopens empty. The other is quiet and
 * embarrassing: an excerpt that comes back blank makes every row in a list
 * indistinguishable from every other.
 */

import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { MAX_EXCERPT, OFFICE_FIELD, documentState, excerptOf, openDocument } from "@/lib/office/content";

/** A document with some writing in it, in the shape the editor produces: a
 *  fragment of XML elements, each holding text. */
function written(paragraphs: readonly string[]): Y.Doc {
    const doc = new Y.Doc();
    const fragment = doc.getXmlFragment(OFFICE_FIELD);
    for (const line of paragraphs) {
        const node = new Y.XmlElement("paragraph");
        node.insert(0, [new Y.XmlText(line)]);
        fragment.push([node]);
    }
    return doc;
}

describe("storing a document", () => {
    it("comes back with everything that was in it", () => {
        const doc = written(["The first paragraph.", "And the second."]);
        const reopened = openDocument(documentState(doc));
        expect(reopened.getXmlFragment(OFFICE_FIELD).toString()).toContain("The first paragraph.");
        expect(reopened.getXmlFragment(OFFICE_FIELD).toString()).toContain("And the second.");
    });

    it("opens a document nobody has typed in yet rather than refusing", () => {
        // A real state: a document exists from the moment it is named, and the
        // editor has to have something to bind to.
        const empty = openDocument(null);
        expect(empty.getXmlFragment(OFFICE_FIELD).length).toBe(0);
    });

    it("survives two updates merging, which is the whole reason for a CRDT", () => {
        const one = written(["Written on the train."]);
        const two = openDocument(documentState(one));
        two.getXmlFragment(OFFICE_FIELD).push([xml("Written at the desk.")]);

        // Each side stored on its own, then merged - which is what a reconnect
        // after an offline edit actually is.
        const merged = openDocument(documentState(one));
        Y.applyUpdate(merged, documentState(two));
        const text = merged.getXmlFragment(OFFICE_FIELD).toString();
        expect(text).toContain("Written on the train.");
        expect(text).toContain("Written at the desk.");
    });
});

describe("the readable line beside it", () => {
    it("is the words, not the markup", () => {
        const excerpt = excerptOf(written(["A quarterly plan", "with two paragraphs."]));
        expect(excerpt).toBe("A quarterly plan with two paragraphs.");
    });

    it("is empty for an empty document rather than something invented", () => {
        expect(excerptOf(openDocument(null))).toBe("");
    });

    it("stops at a length a list can hold", () => {
        const excerpt = excerptOf(written([("word ".repeat(400)).trim()]));
        expect(excerpt.length).toBeLessThanOrEqual(MAX_EXCERPT);
    });

    it("reads whatever shape the document is, not only paragraphs", () => {
        // The five editors store different things - cells, slides, shapes - and
        // the excerpt has to be the words out of any of them rather than knowing
        // one shape.
        const doc = new Y.Doc();
        const rows = doc.getArray("rows");
        const row = new Y.Map();
        row.set("a1", "Revenue");
        row.set("b1", "Competitor");
        rows.push([row]);
        const excerpt = excerptOf(doc);
        expect(excerpt).toContain("Revenue");
        expect(excerpt).toContain("Competitor");
    });
});

function xml(text: string): Y.XmlElement {
    const node = new Y.XmlElement("paragraph");
    node.insert(0, [new Y.XmlText(text)]);
    return node;
}
