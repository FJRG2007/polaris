/**
 * The addresses proposed for Polaris itself. They are read off the zone layout, so
 * the risk is proposing a name nothing answers for: a suggestion that needs a DNS
 * record the operator never created is worse than no suggestion, because it looks
 * exactly as authoritative as one that works.
 */

import { describe, expect, it } from "vitest";
import { domainSuggestions, zoneHost } from "../../src/lib/domain-suggestions";

const zone = (label: string, scope: "polaris" | "deploy", primary = false) => ({ label, scope, primary });

describe("zoneHost", () => {
    it("puts the label in front of the base domain", () => {
        expect(zoneHost("example.com", "polaris")).toBe("polaris.example.com");
    });

    it("uses the base domain itself for an empty label", () => {
        expect(zoneHost("example.com", "")).toBe("example.com");
    });

    it("answers nothing without a base domain", () => {
        expect(zoneHost("", "polaris")).toBe("");
    });
});

describe("domainSuggestions", () => {
    it("proposes the Polaris zone for the dashboard", () => {
        const config = { baseDomain: "example.com", zones: [zone("polaris", "polaris", true)] };
        expect(domainSuggestions(config).app).toBe("polaris.example.com");
    });

    it("keeps the sharing name inside the zone, where the wildcard already answers", () => {
        const config = { baseDomain: "example.com", zones: [zone("polaris", "polaris", true)] };
        // share.example.com would need a record of its own; this one does not.
        expect(domainSuggestions(config).sharing).toBe("share.polaris.example.com");
    });

    it("follows the default when several Polaris zones exist", () => {
        const config = {
            baseDomain: "example.com",
            zones: [zone("old", "polaris"), zone("polaris", "polaris", true)]
        };
        expect(domainSuggestions(config).app).toBe("polaris.example.com");
    });

    it("falls back to the only Polaris zone when none is marked default", () => {
        const config = { baseDomain: "example.com", zones: [zone("polaris", "polaris")] };
        expect(domainSuggestions(config).app).toBe("polaris.example.com");
    });

    it("uses the base domain when the zone has no label", () => {
        const config = { baseDomain: "example.com", zones: [zone("", "polaris", true)] };
        expect(domainSuggestions(config)).toEqual({ app: "example.com", sharing: "share.example.com" });
    });

    it("proposes nothing when only deploy zones are configured", () => {
        const config = { baseDomain: "example.com", zones: [zone("plr", "deploy", true)] };
        expect(domainSuggestions(config)).toEqual({ app: null, sharing: null });
    });

    it("proposes nothing without a base domain", () => {
        const config = { baseDomain: "", zones: [zone("polaris", "polaris", true)] };
        expect(domainSuggestions(config)).toEqual({ app: null, sharing: null });
    });
});
