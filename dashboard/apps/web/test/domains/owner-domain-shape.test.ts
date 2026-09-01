/**
 * What the Add button on a domain screen will accept.
 *
 * It used to come alive on the first keystroke, so a single letter looked like
 * something Polaris would take - and pressing it spent a round trip to be told no
 * by a schema on the other side. A control that offers itself for input it is
 * going to refuse is a control that has to be tried before it can be understood.
 *
 * The two refusals that are easy to get backwards are pinned here. An IPv4
 * address is a well-formed name as far as the pattern goes and is not a domain:
 * nothing can publish a TXT record under it, so a claim on one would sit
 * unverified forever while looking like a claim somebody made. And an empty
 * field is not wrong - nothing has been typed, so there is nothing to be wrong
 * about, and a form that scolds somebody before they start is worse than one
 * that waits.
 */

import { describe, expect, it } from "vitest";
import { domainProblem } from "@/lib/owner-domains-policy";

describe("what is not yet a domain", () => {
    it("says nothing about an empty field", () => {
        expect(domainProblem("")).toBeNull();
        expect(domainProblem("   ")).toBeNull();
    });

    it("refuses a single letter", () => {
        // The whole reason this exists.
        expect(domainProblem("e")).not.toBeNull();
    });

    it("refuses a name with no suffix", () => {
        expect(domainProblem("example")).not.toBeNull();
        expect(domainProblem("localhost")).not.toBeNull();
    });

    it("refuses a suffix that is not one", () => {
        expect(domainProblem("example.c")).not.toBeNull();
        expect(domainProblem("example.123")).not.toBeNull();
    });

    it("refuses an address, and says which it is", () => {
        expect(domainProblem("192.168.1.10")).toBe("That is an address, not a domain");
    });

    it("refuses a label that cannot be one", () => {
        expect(domainProblem("-example.com")).not.toBeNull();
        expect(domainProblem("exa mple.com")).not.toBeNull();
        expect(domainProblem("example-.com")).not.toBeNull();
    });

    it("refuses a name past the length a name can be", () => {
        const long = `${`${"a".repeat(60)}.`.repeat(5)}example.com`;
        expect(domainProblem(long)).not.toBeNull();
    });
});

describe("what is a domain", () => {
    it("takes a plain one", () => {
        expect(domainProblem("example.com")).toBeNull();
    });

    it("takes a delegated subdomain", () => {
        expect(domainProblem("apps.example.com")).toBeNull();
    });

    it("takes a two-part suffix", () => {
        expect(domainProblem("example.co.uk")).toBeNull();
    });

    it("takes one with digits and inner dashes", () => {
        expect(domainProblem("my-site2.example.com")).toBeNull();
    });

    it("takes what somebody pasted out of a browser", () => {
        // The same tidying every other domain field here does: a scheme, a path,
        // a port and a trailing dot are all things people paste, and none of
        // them is a reason to refuse the name inside.
        for (const pasted of [
            "https://example.com",
            "https://example.com/path",
            "example.com:8443",
            "example.com.",
            "*.example.com",
            "  Example.COM  "
        ]) {
            expect(domainProblem(pasted)).toBeNull();
        }
    });
});
