/**
 * When a search stops guessing.
 *
 * The report: a GitHub URL pasted into the task search returned tasks that do
 * not contain it. A fuzzy matcher handed a forty-character string scores almost
 * every row as a partial match, so the answer is a list of everything with the
 * one row that actually contains it somewhere in the middle.
 *
 * Both directions matter equally. A query that names one exact thing has to be
 * matched literally, and a query that is words somebody is half remembering has
 * to stay fuzzy - a rule that sends everything down the literal path would undo
 * the reason every list here is searched fuzzily in the first place.
 */

import { describe, expect, it } from "vitest";
import { isLiteralQuery, literalNeedle, matchesLiterally } from "../src/search-text.js";

describe("a query that names one exact thing", () => {
    it("is an address", () => {
        expect(isLiteralQuery("https://github.com/diegosouzapw/OmniRoute")).toBe(true);
        expect(isLiteralQuery("mailto:someone@example.test")).toBe(true);
    });

    it("is a path, a handle or a fragment", () => {
        expect(isLiteralQuery("src/lib/telemetry")).toBe(true);
        expect(isLiteralQuery("@fjrg2007")).toBe(true);
        expect(isLiteralQuery("#4821")).toBe(true);
    });

    it("is one long unbroken run of characters, which prose is not", () => {
        expect(isLiteralQuery("9f3a1c2e4b5d4f0a8c7b6e5d4c3b2a19")).toBe(true);
    });

    it("is anything somebody put in quotes", () => {
        // The escape hatch, for when the rules above get it wrong.
        expect(isLiteralQuery('"user agent"')).toBe(true);
        expect(literalNeedle('"user agent"')).toBe("user agent");
    });
});

describe("a query that is somebody half remembering", () => {
    it("stays fuzzy", () => {
        expect(isLiteralQuery("useragent")).toBe(false);
        expect(isLiteralQuery("restart the relay")).toBe(false);
        expect(isLiteralQuery("ENG-42")).toBe(false);
        expect(isLiteralQuery("camera")).toBe(false);
    });

    it("stays fuzzy when it is too short to mean anything either way", () => {
        expect(isLiteralQuery("a")).toBe(false);
        expect(isLiteralQuery("/")).toBe(false);
    });

    it("stays fuzzy for a long phrase, because a phrase has spaces in it", () => {
        expect(isLiteralQuery("the deploy that keeps falling over on tuesday")).toBe(false);
    });
});

describe("matching literally", () => {
    const url = "https://github.com/diegosouzapw/OmniRoute";

    it("finds the row that carries the value", () => {
        expect(matchesLiterally(url, [`Look at ${url}`, null])).toBe(true);
    });

    it("does not find the rows that do not", () => {
        // The whole report: these came back, and they contain none of it.
        expect(matchesLiterally(url, ["Restart the relay", "ENG-42"])).toBe(false);
        expect(matchesLiterally(url, ["https://github.com/somebody/else"])).toBe(false);
    });

    it("does not mind the case, and minds nothing else", () => {
        expect(matchesLiterally("OmniRoute", ["a note about omniroute"])).toBe(true);
        expect(matchesLiterally("omni route", ["omniroute"])).toBe(false);
    });

    it("looks for what was quoted, not for the quotes", () => {
        expect(matchesLiterally('"user agent"', ["blocked by user agent"])).toBe(true);
    });

    it("matches nothing when there is nothing to look for", () => {
        expect(matchesLiterally('""', ["anything"])).toBe(false);
    });
});
