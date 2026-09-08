/**
 * Which site is asked for a sender's mark.
 *
 * Almost nobody sends from the domain their logo is on, so asking only the exact
 * host is why a mailbox full of household names showed initials. What makes it
 * awkward is where a host stops belonging to somebody: `apple.com` is two labels
 * and `bbc.co.uk` is three, and the difference is a public-suffix list that is
 * thousands of entries long.
 *
 * The compromise here is deliberate and its edges are what these check. The one
 * answer that would be actively wrong is asking a registry - `co.uk` has a front
 * page, and its icon on every British sender in the list would be worse than the
 * initials this replaced.
 */

import { describe, expect, it } from "vitest";
import { baseDomain, markDomains } from "@/lib/mailbox/sender-domain";

describe("the domain a sending host belongs to", () => {
    it("finds the plain one under a sending subdomain", () => {
        expect(baseDomain("email.apple.com")).toBe("apple.com");
        expect(baseDomain("mail.notifications.shopify.com")).toBe("shopify.com");
    });

    it("keeps the extra label a country registry needs", () => {
        expect(baseDomain("mail.bbc.co.uk")).toBe("bbc.co.uk");
        expect(baseDomain("news.universidad.edu.ar")).toBe("universidad.edu.ar");
        expect(baseDomain("send.loja.com.br")).toBe("loja.com.br");
    });

    it("has nothing to add to a domain that is already the one", () => {
        expect(baseDomain("apple.com")).toBeNull();
        expect(baseDomain("bbc.co.uk")).toBeNull();
    });

    it("never offers a registry as a sender's own site", () => {
        // The one wrong answer that would show somebody else's logo rather than
        // no logo.
        expect(markDomains("bbc.co.uk")).toEqual(["bbc.co.uk", "www.bbc.co.uk"]);
        expect(markDomains("mail.bbc.co.uk")).toEqual([
            "mail.bbc.co.uk",
            "bbc.co.uk",
            "www.bbc.co.uk"
        ]);
    });

    it("asks the www of the domain itself", () => {
        // A site whose real one is on `www` commonly answers its bare form with
        // a marketing page and no 404 at all, so the exact host looks like it
        // has a mark and the mark is a web page.
        expect(markDomains("linkedin.com")).toEqual(["linkedin.com", "www.linkedin.com"]);
    });

    it("does not ask the same host twice", () => {
        expect(markDomains("www.example.com")).toEqual(["www.example.com", "example.com"]);
    });

    it("asks at most three times, whatever the host", () => {
        // Each one is a request to somebody else's server, made while a mailbox
        // is being scrolled.
        expect(markDomains("a.b.c.d.example.com")).toEqual([
            "a.b.c.d.example.com",
            "example.com",
            "www.example.com"
        ]);
    });

    it("has nothing to ask about something that is not a domain", () => {
        expect(markDomains("localhost")).toEqual([]);
    });
});
