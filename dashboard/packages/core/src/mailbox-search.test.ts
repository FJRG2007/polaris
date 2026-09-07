/**
 * The mail search grammar.
 *
 * The box and the filter panel are the same search read in two directions, so
 * the property that matters most is the round trip: whatever the panel writes
 * has to parse back to what the panel had, or the two quietly disagree and
 * opening the panel loses half of somebody's search.
 */

import { describe, expect, it } from "vitest";
import * as search from "./mailbox-search.js";

/** Midday, so a relative date cannot land on the wrong side of a day boundary
 *  while the test is running. */
const NOW = new Date("2026-09-07T12:00:00");

describe("what somebody typed", () => {
    it("finds the words when there are no operators at all", () => {
        const terms = search.parseMailSearch("quarterly report");
        expect(terms.text).toBe("quarterly report");
        expect(search.searchIsEmpty(terms)).toBe(false);
    });

    it("reads who a message is from, to and copied to", () => {
        const terms = search.parseMailSearch("from:Ana to:equipo@example.com cc:jefe");
        expect(terms.from).toEqual(["ana"]);
        expect(terms.to).toEqual(["equipo@example.com"]);
        expect(terms.cc).toEqual(["jefe"]);
        expect(terms.text).toBe("");
    });

    it("keeps a quoted value in one piece", () => {
        const terms = search.parseMailSearch('subject:"the quarterly report" from:ana');
        expect(terms.subject).toEqual(["the quarterly report"]);
        expect(terms.from).toEqual(["ana"]);
    });

    it("tells an exact phrase from loose words", () => {
        const terms = search.parseMailSearch('renewal "final notice"');
        expect(terms.phrases).toEqual(["final notice"]);
        expect(terms.text).toBe("renewal");
    });

    it("takes a word out", () => {
        const terms = search.parseMailSearch("factura -borrador");
        expect(terms.without).toEqual(["borrador"]);
        expect(terms.text).toBe("factura");
    });

    it("reads what a message carries and what state it is in", () => {
        const terms = search.parseMailSearch("has:attachment has:link is:unread is:starred");
        expect(terms.hasAttachment).toBe(true);
        expect(terms.hasLink).toBe(true);
        expect(terms.unread).toBe(true);
        expect(terms.starred).toBe(true);
    });

    it("reads is:read as the other half of is:unread rather than as a third state", () => {
        expect(search.parseMailSearch("is:read").unread).toBe(false);
        expect(search.parseMailSearch("-is:unread").unread).toBe(false);
    });

    it("takes a date as written or as a length of time", () => {
        expect(search.parseMailSearch("after:2026-01-31", NOW).after).toBe("2026-01-31");
        expect(search.parseMailSearch("before:2026/02/01", NOW).before).toBe("2026-02-01");
        // Resolved to a day rather than carried, so a bookmarked search means the
        // same thing tomorrow as it did when it was saved.
        expect(search.parseMailSearch("newer_than:7d", NOW).after).toBe("2026-08-31");
        expect(search.parseMailSearch("older_than:1y", NOW).before).toBe("2025-09-07");
    });

    it("treats a colon in a sentence as a sentence", () => {
        // The failure every search box has: somebody pastes a subject line and
        // gets an error, or worse, silence.
        const terms = search.parseMailSearch("Re: pedido 4471");
        expect(terms.text).toBe("Re: pedido 4471");
        expect(terms.from).toEqual([]);
    });

    it("is empty when nothing was asked for", () => {
        expect(search.searchIsEmpty(search.parseMailSearch("   "))).toBe(true);
        expect(search.searchIsEmpty(search.EMPTY_SEARCH)).toBe(true);
    });
});

describe("what the panel writes back", () => {
    it("comes back as what it started as", () => {
        for (const line of [
            "from:ana",
            'from:ana subject:"final notice" has:attachment is:unread',
            "after:2026-01-01 before:2026-02-01",
            'to:equipo@example.com cc:jefe "exact words" -borrador facturas',
            "has:link is:starred is:read"
        ]) {
            const once = search.parseMailSearch(line, NOW);
            const written = search.formatMailSearch(once);
            expect(search.parseMailSearch(written, NOW), line).toEqual(once);
        }
    });

    it("quotes only what has to be quoted", () => {
        expect(search.formatMailSearch({ ...search.EMPTY_SEARCH, from: ["ana"] })).toBe("from:ana");
        expect(search.formatMailSearch({ ...search.EMPTY_SEARCH, subject: ["two words"] })).toBe(
            'subject:"two words"'
        );
    });
});

/** One message, as the matcher reads it. */
function message(over: Partial<search.MailSearchable> = {}): search.MailSearchable {
    return {
        subject: "Factura de septiembre",
        snippet: "Adjuntamos la factura del mes.",
        body: "Adjuntamos la factura del mes. https://facturas.example.com/4471",
        from: ["Ana Ruiz", "ana@example.com"],
        to: ["yo@example.com"],
        cc: [],
        hasAttachments: true,
        seen: false,
        flagged: false,
        sentAt: new Date("2026-09-01T10:00:00"),
        ...over
    };
}

describe("what a search admits", () => {
    it("matches a sender by name or by address", () => {
        expect(search.mailSearchAdmits(message(), search.parseMailSearch("from:ana"))).toBe(true);
        expect(search.mailSearchAdmits(message(), search.parseMailSearch("from:ruiz"))).toBe(true);
        expect(search.mailSearchAdmits(message(), search.parseMailSearch("from:example.com"))).toBe(true);
        expect(search.mailSearchAdmits(message(), search.parseMailSearch("from:carlos"))).toBe(false);
    });

    it("holds an exact phrase to the letter", () => {
        expect(search.mailSearchAdmits(message(), search.parseMailSearch('"la factura del mes"'))).toBe(true);
        expect(search.mailSearchAdmits(message(), search.parseMailSearch('"la factura del anio"'))).toBe(false);
    });

    it("refuses a message carrying a word that was excluded", () => {
        expect(search.mailSearchAdmits(message(), search.parseMailSearch("-factura"))).toBe(false);
        // Including when the word is somebody's name rather than in the text.
        expect(search.mailSearchAdmits(message(), search.parseMailSearch("-ana"))).toBe(false);
    });

    it("knows an attachment from a link", () => {
        expect(search.mailSearchAdmits(message(), search.parseMailSearch("has:attachment"))).toBe(true);
        expect(
            search.mailSearchAdmits(message({ hasAttachments: false }), search.parseMailSearch("has:attachment"))
        ).toBe(false);
        expect(search.mailSearchAdmits(message(), search.parseMailSearch("has:link"))).toBe(true);
        expect(
            search.mailSearchAdmits(
                message({ body: "sin enlaces", snippet: "sin enlaces" }),
                search.parseMailSearch("has:link")
            )
        ).toBe(false);
    });

    it("finds a link on the second message as well as the first", () => {
        // A global expression keeps its place between calls, which would make
        // every other message look like it had no links in it.
        const terms = search.parseMailSearch("has:link");
        expect(search.mailSearchAdmits(message(), terms)).toBe(true);
        expect(search.mailSearchAdmits(message(), terms)).toBe(true);
        expect(search.mailSearchAdmits(message(), terms)).toBe(true);
    });

    it("reads a date range as whole days", () => {
        const sameDay = message({ sentAt: new Date("2026-09-01T23:30:00") });
        // `before:` the same day includes the whole of it, which is what anybody
        // means by it - not midnight at its start.
        expect(search.mailSearchAdmits(sameDay, search.parseMailSearch("before:2026-09-01"))).toBe(true);
        expect(search.mailSearchAdmits(sameDay, search.parseMailSearch("after:2026-09-01"))).toBe(true);
        expect(search.mailSearchAdmits(sameDay, search.parseMailSearch("after:2026-09-02"))).toBe(false);
    });

    it("reads the state a message is in", () => {
        expect(search.mailSearchAdmits(message({ seen: false }), search.parseMailSearch("is:unread"))).toBe(true);
        expect(search.mailSearchAdmits(message({ seen: true }), search.parseMailSearch("is:unread"))).toBe(false);
        expect(search.mailSearchAdmits(message({ seen: true }), search.parseMailSearch("is:read"))).toBe(true);
        expect(search.mailSearchAdmits(message({ flagged: true }), search.parseMailSearch("is:starred"))).toBe(
            true
        );
    });

    it("leaves the loose words alone, because those are ranked rather than tested", () => {
        // A word nobody in the message ever wrote still gets through here; Fuse
        // is what decides whether it is close enough to anything.
        expect(search.mailSearchAdmits(message(), search.parseMailSearch("cualquiercosa"))).toBe(true);
    });
});
