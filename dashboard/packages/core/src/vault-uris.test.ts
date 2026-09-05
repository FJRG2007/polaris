/**
 * Which addresses a saved login belongs to.
 *
 * Two failures matter here and they are not symmetrical. Matching too little
 * means autofill is not offered and somebody types a password by hand, which is
 * an annoyance. Matching too much means a credential is offered on somebody
 * else's site, which is how a password ends up typed into a phishing page - so
 * every case below that could go either way is pinned on the narrow side.
 *
 * The wildcard is the one transformation: everybody writes `*.example.com` and
 * means "that site and anything under it", so it is accepted as typed and stored
 * as the base-domain match, which is what it means and what every other client
 * already implements.
 */

// The match numbers are Bitwarden's and live with the rest of its wire
// vocabulary; the rules that read them live here.
import * as wire from "./vault.js";
import * as uris from "./vault-uris.js";
import { describe, expect, it } from "vitest";

describe("the wildcard people actually type", () => {
    it("becomes the match that means the same thing", () => {
        expect(uris.readUriEntry("*.example.com", null)).toEqual({
            uri: "example.com",
            match: wire.URI_MATCH_DOMAIN
        });
    });

    it("leaves an ordinary address as it was typed", () => {
        // A URL somebody pasted is a URL they may want to read again.
        expect(uris.readUriEntry("https://example.com/login?next=x", null)).toEqual({
            uri: "https://example.com/login?next=x",
            match: null
        });
    });
});

describe("the site and anything under it", () => {
    const covers = (saved: string, candidate: string) =>
        uris.uriMatches(saved, wire.URI_MATCH_DOMAIN, candidate);

    it("covers the site itself and its subdomains", () => {
        expect(covers("example.com", "https://example.com/in")).toBe(true);
        expect(covers("example.com", "https://accounts.example.com/in")).toBe(true);
        expect(covers("https://example.com", "https://deep.accounts.example.com")).toBe(true);
    });

    it("covers them from a two-label suffix as well", () => {
        expect(covers("example.co.uk", "https://accounts.example.co.uk")).toBe(true);
    });

    it("does not cover a different site that ends the same way", () => {
        // The failure this whole file exists to prevent: a credential offered on
        // somebody else's page.
        expect(covers("example.com", "https://notexample.com")).toBe(false);
        expect(covers("example.com", "https://example.com.evil.test")).toBe(false);
    });
});

describe("the narrower rules", () => {
    it("matches one host and not its neighbours", () => {
        expect(uris.uriMatches("accounts.example.com", wire.URI_MATCH_HOST, "https://accounts.example.com/x")).toBe(true);
        expect(uris.uriMatches("accounts.example.com", wire.URI_MATCH_HOST, "https://example.com/x")).toBe(false);
    });

    it("matches a prefix, for a site that keeps its logins under one path", () => {
        const saved = "https://example.com/apps/";
        expect(uris.uriMatches(saved, wire.URI_MATCH_STARTS_WITH, "https://example.com/apps/mail")).toBe(true);
        expect(uris.uriMatches(saved, wire.URI_MATCH_STARTS_WITH, "https://example.com/other")).toBe(false);
    });

    it("matches one address exactly", () => {
        const saved = "https://example.com/login";
        expect(uris.uriMatches(saved, wire.URI_MATCH_EXACT, "https://example.com/login")).toBe(true);
        expect(uris.uriMatches(saved, wire.URI_MATCH_EXACT, "https://example.com/login?x=1")).toBe(false);
    });

    it("never offers an entry marked never", () => {
        expect(uris.uriMatches("example.com", wire.URI_MATCH_NEVER, "https://example.com")).toBe(false);
    });
});

describe("a pattern somebody wrote themselves", () => {
    it("is used as written", () => {
        expect(uris.uriMatches("^https://(a|b)\\.example\\.com/", wire.URI_MATCH_REGEX, "https://a.example.com/x")).toBe(
            true
        );
        expect(uris.uriMatches("^https://(a|b)\\.example\\.com/", wire.URI_MATCH_REGEX, "https://c.example.com/x")).toBe(
            false
        );
    });

    it("matches nothing at all when it will not compile", () => {
        // Matching everything is the alternative, and it would offer this
        // credential on every page there is.
        expect(uris.uriMatches("(", wire.URI_MATCH_REGEX, "https://example.com")).toBe(false);
    });
});

describe("what is not an address", () => {
    it("matches nothing", () => {
        expect(uris.uriMatches("", null, "https://example.com")).toBe(false);
        expect(uris.uriMatches("example.com", null, "")).toBe(false);
        expect(uris.uriMatches("not a url at all", wire.URI_MATCH_DOMAIN, "https://example.com")).toBe(false);
    });
});

describe("reading what was stored", () => {
    it("keeps a match a client wrote and drops one it did not", () => {
        expect(uris.readUriMatch(0)).toBe(wire.URI_MATCH_DOMAIN);
        expect(uris.readUriMatch(5)).toBe(wire.URI_MATCH_NEVER);
        expect(uris.readUriMatch(9)).toBeNull();
        expect(uris.readUriMatch("nonsense")).toBeNull();
        // Null is Bitwarden's "whatever the default is", and stays null.
        expect(uris.readUriMatch(null)).toBeNull();
    });
});

describe("what is wrong with what was typed", () => {
    it("says nothing about an empty box", () => {
        // Unfinished is not the same as wrong, and a form that says "not valid"
        // over a field nobody has filled in yet is arguing with somebody who has
        // not spoken.
        expect(uris.uriProblem("", null)).toBeNull();
        expect(uris.uriProblem("   ", null)).toBeNull();
    });

    it("accepts the addresses a vault actually holds", () => {
        // Not only public sites: a vault holds the router, a machine on the LAN
        // with no dot in its name, and a port. Refusing those is a form arguing
        // with somebody about their own network.
        for (const value of [
            "example.com",
            "https://example.com/login?next=x",
            "*.example.com",
            "localhost:8080",
            "192.168.1.1",
            "nas"
        ]) {
            expect(uris.uriProblem(value, null)).toBeNull();
        }
    });

    it("refuses what cannot be an address at all", () => {
        expect(uris.uriProblem("not an address", null)).toBeTruthy();
        expect(uris.uriProblem("https://", null)).toBeTruthy();
        expect(uris.uriProblem("https://exa mple.com", null)).toBeTruthy();
    });

    it("reads a pattern as a pattern rather than as an address", () => {
        // Under this rule the value is a regular expression. Reading it as a URL
        // would refuse every correct pattern and accept every broken one.
        expect(uris.uriProblem("^https://(a|b)\.example\.com/", wire.URI_MATCH_REGEX)).toBeNull();
        expect(uris.uriProblem("(", wire.URI_MATCH_REGEX)).toBeTruthy();
    });
});

describe("choosing between several saved addresses", () => {
    it("offers the most specific first", () => {
        const entries: { uri: string; match: uris.UriMatch | null }[] = [
            { uri: "example.com", match: wire.URI_MATCH_DOMAIN },
            { uri: "https://example.com/login", match: wire.URI_MATCH_EXACT }
        ];
        expect(uris.urisCovering(entries, "https://example.com/login")[0]?.match).toBe(
            wire.URI_MATCH_EXACT
        );
    });

    it("leaves out the ones that do not cover the page", () => {
        const entries: { uri: string; match: uris.UriMatch | null }[] = [
            { uri: "example.com", match: wire.URI_MATCH_DOMAIN },
            { uri: "other.test", match: wire.URI_MATCH_DOMAIN }
        ];
        expect(uris.urisCovering(entries, "https://example.com")).toHaveLength(1);
    });
});
