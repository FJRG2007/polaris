/**
 * The XML reader under the CalDAV client.
 *
 * Servers pick their own namespace prefixes, so the reader must name elements
 * by namespace URI; and the documents come from servers a user typed in, so a
 * DOCTYPE must never be able to define an entity that gets expanded.
 */

import { describe, expect, it } from "vitest";
import {
    XmlError,
    child,
    childrenOf,
    parseXml,
    textContent
} from "@polaris-app/calendar/src/lib/sync/xml";

describe("parseXml", () => {
    it("names elements by namespace URI, whatever the prefix", () => {
        const a = parseXml(`<d:multistatus xmlns:d="DAV:"><d:response/></d:multistatus>`);
        const b = parseXml(`<x:multistatus xmlns:x="DAV:"><x:response/></x:multistatus>`);
        const c = parseXml(`<multistatus xmlns="DAV:"><response/></multistatus>`);
        for (const root of [a, b, c]) {
            expect(root.ns).toBe("DAV:");
            expect(root.local).toBe("multistatus");
            expect(childrenOf(root, "DAV:", "response")).toHaveLength(1);
        }
    });

    it("scopes a redeclared prefix and a default namespace to their element", () => {
        const root = parseXml(
            `<a:root xmlns:a="urn:one" xmlns="urn:default"><a:x xmlns:a="urn:two"><a:y/></a:x><a:z/><plain/><other xmlns=""><bare/></other></a:root>`
        );
        expect(child(root, "urn:two", "x")).not.toBeNull();
        expect(child(child(root, "urn:two", "x"), "urn:two", "y")).not.toBeNull();
        expect(child(root, "urn:one", "z")).not.toBeNull();
        expect(child(root, "urn:default", "plain")).not.toBeNull();
        expect(child(child(root, "", "other"), "", "bare")).not.toBeNull();
    });

    it("decodes the predefined entities and character references", () => {
        const root = parseXml(
            `<t a="&quot;q&quot; &amp; &#x41;">&lt;b&gt; &amp; &apos;s&apos; &#65;&#x1F600;</t>`
        );
        expect(root.text).toBe("<b> & 's' A\u{1F600}");
        expect(root.attrs.get("a")).toBe('"q" & A');
    });

    it("keeps CDATA verbatim, markup and entities included", () => {
        const root = parseXml(
            `<t><![CDATA[BEGIN:VCALENDAR\r\nSUMMARY:a <b> &amp; c\r\nEND:VCALENDAR]]></t>`
        );
        expect(root.text).toBe("BEGIN:VCALENDAR\nSUMMARY:a <b> &amp; c\nEND:VCALENDAR");
    });

    it("reads self-closing tags, comments and processing instructions", () => {
        const root = parseXml(
            `<?xml version="1.0"?><!-- a comment --><r><e/><e x='1' /><?pi data?></r>`
        );
        expect(root.children).toHaveLength(2);
        expect(root.children[1]!.attrs.get("x")).toBe("1");
    });

    it("never expands an entity a DOCTYPE declares", () => {
        const doc = `<?xml version="1.0"?>
<!DOCTYPE r [
  <!ENTITY xxe SYSTEM "file:///etc/passwd">
  <!ENTITY lol "lollollollollol">
  <!ENTITY lol2 "&lol;&lol;&lol;&lol;">
]>
<r>&xxe;|&lol2;</r>`;
        const root = parseXml(doc);
        expect(root.text).toBe("&xxe;|&lol2;");
        expect(textContent(root)).not.toContain("lollol");
    });

    it("refuses malformed documents", () => {
        expect(() => parseXml("<a><b></a>")).toThrow(XmlError);
        expect(() => parseXml("<p:a/>")).toThrow(XmlError);
        expect(() => parseXml("<a>")).toThrow(XmlError);
        expect(() => parseXml("<a/><b/>")).toThrow(XmlError);
        expect(() => parseXml("<a x=1/>")).toThrow(XmlError);
        expect(() => parseXml("")).toThrow(XmlError);
    });
});
