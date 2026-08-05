/**
 * Domains people bring themselves.
 *
 * Two rules are pinned here because getting either wrong is quiet and expensive.
 *
 * A cap of zero means "no cap", because the field it comes from is a number input
 * and an empty one has to mean unlimited rather than none-allowed - reading it the
 * other way would stop everybody adding anything, and look like the feature simply
 * not working.
 *
 * And the picker key for a brought domain has to be impossible to confuse with a
 * DNS label the operator configured. If the two could collide, a service asking
 * for one zone would be minted a hostname in the other - published on somebody
 * else's domain, with a certificate ordered for it.
 */

import { describe, expect, it } from "vitest";
import { normalizeBaseDomain } from "@polaris/deploy";
import { ownerZoneDomain, ownerZoneKey } from "@/lib/domain-zones";
import {
    ownerDomainInputSchema,
    ownerDomainPolicySchema,
    OWNER_DOMAIN_POLICY_DEFAULTS
} from "@/lib/owner-domains";

describe("who may bring a domain", () => {
    it("starts an instance offering it, uncapped", () => {
        expect(OWNER_DOMAIN_POLICY_DEFAULTS).toEqual({ mode: "everyone", maxPerOwner: 0 });
    });

    it("fills in what an older stored policy is missing rather than discarding it", () => {
        const parsed = ownerDomainPolicySchema.safeParse({ mode: "admins" });

        expect(parsed.success).toBe(true);
        expect(parsed.success && parsed.data).toEqual({ mode: "admins", maxPerOwner: 0 });
    });

    it("refuses a negative cap and a mode it does not have", () => {
        expect(ownerDomainPolicySchema.safeParse({ maxPerOwner: -1 }).success).toBe(false);
        expect(ownerDomainPolicySchema.safeParse({ mode: "sometimes" }).success).toBe(false);
    });
});

describe("what may be claimed", () => {
    it("takes what somebody would actually paste", () => {
        for (const typed of ["example.com", "https://Example.com/", "*.example.com", "example.com:8080", "example.com."]) {
            const parsed = ownerDomainInputSchema.safeParse({ domain: typed });
            expect(parsed.success, typed).toBe(true);
            expect(parsed.success && parsed.data.domain, typed).toBe("example.com");
        }
    });

    it("accepts a delegated subdomain, which is the safer thing to point at a box", () => {
        expect(ownerDomainInputSchema.parse({ domain: "apps.example.com" }).domain).toBe("apps.example.com");
    });

    it("refuses anything that is not a domain", () => {
        for (const typed of ["", "localhost", "example", "not a domain", "10.0.0.1/24"]) {
            expect(ownerDomainInputSchema.safeParse({ domain: typed }).success, typed).toBe(false);
        }
    });
});

describe("the key a picker sends back", () => {
    it("round-trips the domain it names", () => {
        expect(ownerZoneDomain(ownerZoneKey("example.com"))).toBe("example.com");
        expect(ownerZoneDomain(ownerZoneKey("apps.example.com"))).toBe("apps.example.com");
    });

    it("cannot be produced by an operator zone label", () => {
        // A zone label is a DNS label, and "@" is not legal in one - which is
        // exactly why it was chosen. The empty label (the base domain itself) and
        // the sentinel the picker uses for it must both read as "not a brought
        // domain", or the root zone would resolve to a domain with no name.
        for (const label of ["", "plr", "polaris", "apps", "@"]) {
            expect(ownerZoneDomain(label), label).toBeFalsy();
        }
        expect(ownerZoneDomain(undefined)).toBeNull();
    });

    it("names a domain in the form the service stores", () => {
        // The key is built from a stored domain, so it must already be normalized;
        // a key carrying "Example.com" would never match what was verified.
        const stored = normalizeBaseDomain("https://Example.com/");
        expect(ownerZoneDomain(ownerZoneKey(stored))).toBe("example.com");
    });
});
