/**
 * What a search result shows: the words it marks, the line it picks, and the
 * chips it is taken apart into.
 */

import { describe, expect, it } from "vitest";
import * as search from "./mailbox-search.js";
import * as marks from "./mailbox-search-marks.js";

const needles = (line: string) => marks.mailSearchNeedles(search.parseMailSearch(line));

describe("the words a search marks", () => {
    it("takes the loose words, the phrases and the subject, folded", () => {
        expect(needles('Acción "Quarterly Report" subject:Factura from:ana')).toEqual([
            "quarterly report",
            "factura",
            "accion"
        ]);
    });

    it("marks nothing for a search of only operators", () => {
        expect(needles("from:ana has:attachment")).toEqual([]);
    });
});

describe("marking text", () => {
    it("ignores case and accents, and marks the text as written", () => {
        const segments = marks.markMailSearch("La ACCIÓN de hoy", ["accion"]);
        expect(segments).toEqual([
            { text: "La ", hit: false },
            { text: "ACCIÓN", hit: true },
            { text: " de hoy", hit: false }
        ]);
    });

    it("marks every occurrence and merges ones that overlap", () => {
        const hits = marks.mailSearchHits("report quarterly report", ["quarterly report", "report"]);
        expect(hits).toEqual([
            [0, 6],
            [7, 23]
        ]);
    });

    it("keeps markup in the text as characters, never as markup", () => {
        const segments = marks.markMailSearch("<script>alert(1)</script> invoice", ["invoice"]);
        expect(segments.map((one) => one.text).join("")).toBe("<script>alert(1)</script> invoice");
        expect(segments.filter((one) => one.hit)).toEqual([{ text: "invoice", hit: true }]);
    });

    it("leaves text alone when nothing was asked for", () => {
        expect(marks.markMailSearch("hello", [])).toEqual([{ text: "hello", hit: false }]);
        expect(marks.markMailSearch("", ["x"])).toEqual([]);
    });
});

describe("the excerpt", () => {
    const long = `${"intro ".repeat(60)}the contract was signed today ${"tail ".repeat(60)}`;

    it("is taken from around the first match, with ellipses where it was cut", () => {
        const line = marks.mailSearchExcerpt(long, ["contract"], 80);
        expect(line).toContain("contract");
        expect(line.startsWith("...")).toBe(true);
        expect(line.endsWith("...")).toBe(true);
        expect(line.length).toBeLessThanOrEqual(86);
    });

    it("falls back to the start when nothing matched", () => {
        expect(marks.mailSearchExcerpt(long, ["absent"], 40).startsWith("intro")).toBe(true);
    });

    it("returns a short text whole", () => {
        expect(marks.mailSearchExcerpt("  short\n line ", ["line"])).toBe("short line");
    });
});

describe("chips", () => {
    it("lists every condition but the loose words, and takes one off", () => {
        const terms = search.parseMailSearch('from:ana "exact words" -spam has:attachment invoice');
        const chips = marks.mailSearchChips(terms);
        expect(chips.map((chip) => chip.id)).toEqual([
            "from:0",
            "phrases:0",
            "without:0",
            "has:attachment"
        ]);
        const fewer = marks.withoutMailSearchChip(terms, "from:0");
        expect(search.formatMailSearch(fewer)).toBe('has:attachment "exact words" -spam invoice');
    });
});

describe("operator hints", () => {
    it("offers the operators the last word starts", () => {
        expect(marks.mailSearchOperatorHints("invoice fr").map((one) => one.insert)).toEqual(["from:"]);
        expect(marks.mailSearchOperatorHints("is:").map((one) => one.insert)).toEqual([
            "is:unread",
            "is:read",
            "is:starred"
        ]);
        expect(marks.mailSearchOperatorHints("")).toEqual([]);
        expect(marks.mailSearchOperatorHints("from:")).toEqual([]);
    });

    it("replaces the last word with the one picked", () => {
        expect(marks.applyMailSearchOperator("invoice fr", "from:")).toBe("invoice from:");
        expect(marks.applyMailSearchOperator("-has", "has:attachment")).toBe("-has:attachment ");
    });
});

describe("recent searches", () => {
    it("puts the newest first, once, and keeps a bounded list", () => {
        let recent: string[] = [];
        for (let at = 0; at < 12; at++) recent = marks.rememberMailSearch(recent, `q${at}`);
        recent = marks.rememberMailSearch(recent, " q5 ");
        expect(recent[0]).toBe("q5");
        expect(recent.filter((one) => one === "q5")).toHaveLength(1);
        expect(recent).toHaveLength(marks.RECENT_MAIL_SEARCHES);
        expect(marks.rememberMailSearch(recent, "   ")).toEqual(recent);
    });
});

describe("the new operators", () => {
    it("reads filename, label and order, and writes them back", () => {
        const terms = search.parseMailSearch("filename:Factura.pdf label:Work order:relevance");
        expect(terms.filename).toEqual(["factura.pdf"]);
        expect(terms.label).toEqual(["work"]);
        expect(terms.order).toBe("relevance");
        expect(search.parseMailSearch(search.formatMailSearch(terms))).toEqual(terms);
    });

    it("does not count an order alone as a search", () => {
        expect(search.searchIsEmpty(search.parseMailSearch("order:relevance"))).toBe(true);
    });

    it("admits a message by its file names and labels", () => {
        const message = {
            subject: "",
            snippet: "",
            body: "",
            from: [],
            to: [],
            cc: [],
            hasAttachments: true,
            seen: true,
            flagged: false,
            sentAt: new Date("2026-01-01"),
            attachmentNames: ["Factura-2026.pdf"],
            labels: ["Work"]
        };
        expect(search.mailSearchAdmits(message, search.parseMailSearch("filename:factura"))).toBe(true);
        expect(search.mailSearchAdmits(message, search.parseMailSearch("filename:contrato"))).toBe(false);
        expect(search.mailSearchAdmits(message, search.parseMailSearch("label:work"))).toBe(true);
        expect(search.mailSearchAdmits(message, search.parseMailSearch("label:home"))).toBe(false);
    });
});
