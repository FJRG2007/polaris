/**
 * Whether a saved login belongs to the page in front of somebody.
 *
 * The most important thing in the extension to get right, and the reason this
 * logic was pulled out of the worker: a wrong answer types a password into
 * somebody else's site. Everything else here - a list, a badge, a copy button -
 * is a convenience. This is the part that can do harm.
 *
 * The strategies themselves are `@polaris/core`'s and are tested there; what is
 * pinned here is the two rules this file adds around them, and the refusals.
 */

import { describe, expect, it } from "vitest";
import { URI_MATCH_EXACT, URI_MATCH_HOST, URI_MATCH_NEVER, type UriMatch } from "@polaris/core";
import {
    displayHost,
    matchesPage,
    rankForPage,
    type Matchable,
    type SavedUri
} from "../src/lib/matching";

const saved = (uri: string, match: UriMatch | null = null): SavedUri => ({ uri, match });
const item = (name: string, ...uris: SavedUri[]): Matchable => ({ name, uris });

describe("whether a login is for this page", () => {
    it("matches the site it was saved for", () => {
        expect(matchesPage([saved("https://example.com")], "https://example.com/login")).toBe(true);
    });

    it("matches a subdomain of it, which is what a base domain means", () => {
        // The default strategy, and the one people rely on without knowing its
        // name: a password saved for the site opens the account subdomain too.
        expect(
            matchesPage([saved("https://example.com")], "https://accounts.example.com/signin")
        ).toBe(true);
    });

    it("does not match a different site that merely contains the name", () => {
        // The failure that matters. A site can put anything in its own address.
        expect(matchesPage([saved("https://example.com")], "https://example.com.evil.test/")).toBe(
            false
        );
        expect(matchesPage([saved("https://example.com")], "https://notexample.com/")).toBe(false);
        expect(
            matchesPage([saved("https://example.com")], "https://evil.test/?q=example.com")
        ).toBe(false);
    });

    it("honours never, whatever else the item says", () => {
        // Somebody's only way of saying "not here, ever". It has to beat an
        // address that would otherwise match exactly.
        expect(matchesPage([saved("https://example.com", URI_MATCH_NEVER)], "https://example.com/")).toBe(
            false
        );
    });

    it("takes host to mean the host, and exact to mean exactly that", () => {
        expect(
            matchesPage([saved("https://accounts.example.com", URI_MATCH_HOST)], "https://accounts.example.com/x")
        ).toBe(true);
        expect(
            matchesPage([saved("https://accounts.example.com", URI_MATCH_HOST)], "https://other.example.com/x")
        ).toBe(false);
        expect(
            matchesPage([saved("https://example.com/login", URI_MATCH_EXACT)], "https://example.com/login")
        ).toBe(true);
        expect(
            matchesPage([saved("https://example.com/login", URI_MATCH_EXACT)], "https://example.com/login?next=1")
        ).toBe(false);
    });

    it("says no for an item saved for nowhere", () => {
        expect(matchesPage([], "https://example.com/")).toBe(false);
    });
});

describe("which one comes first", () => {
    it("puts the closer host before the base-domain match", () => {
        const ranked = rankForPage(
            [item("Site", saved("https://example.com")), item("Accounts", saved("https://accounts.example.com"))],
            "https://accounts.example.com/signin"
        );
        expect(ranked.map((one) => one.name)).toEqual(["Accounts", "Site"]);
    });

    it("is stable when nothing separates them", () => {
        // A list that reshuffles between two openings is one nobody can learn.
        const items = [item("Beta", saved("https://example.com")), item("Alpha", saved("https://example.com"))];
        expect(rankForPage(items, "https://example.com/").map((one) => one.name)).toEqual([
            "Alpha",
            "Beta"
        ]);
        expect(rankForPage([...items].reverse(), "https://example.com/").map((one) => one.name)).toEqual([
            "Alpha",
            "Beta"
        ]);
    });

    it("leaves out everything that does not match", () => {
        const ranked = rankForPage(
            [
                item("Wanted", saved("https://example.com")),
                item("Elsewhere", saved("https://other.test")),
                item("Refused", saved("https://example.com", URI_MATCH_NEVER))
            ],
            "https://example.com/"
        );
        expect(ranked.map((one) => one.name)).toEqual(["Wanted"]);
    });
});

describe("what the list shows beside an item", () => {
    it("is the first address saved for it", () => {
        expect(displayHost([saved("https://accounts.example.com/x"), saved("https://example.com")])).toBe(
            "accounts.example.com"
        );
    });

    it("is nothing when it was saved for nowhere", () => {
        expect(displayHost([])).toBeNull();
    });
});
