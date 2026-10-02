/**
 * Reading a domain's registration from RDAP: which server answers for a TLD,
 * and what an answer says about expiry, the transfer lock, the registrar and
 * whether the holder is published.
 */

import { describe, expect, it } from "vitest";
import {
    mergeRegistration,
    parseRdapDomain,
    rdapBaseFor,
    relatedRdapLink
} from "@/lib/domain-security/rdap";

const BOOTSTRAP = {
    services: [
        [["com", "net"], ["https://rdap.example-registry.test/com/v1/"]],
        [["org"], ["http://insecure.example.test/", "https://rdap.example-org.test"]]
    ]
};

describe("RDAP", () => {
    it("finds the HTTPS server for a domain's TLD", () => {
        expect(rdapBaseFor(BOOTSTRAP, "example.com")).toBe(
            "https://rdap.example-registry.test/com/v1/"
        );
        expect(rdapBaseFor(BOOTSTRAP, "a.b.example.org")).toBe("https://rdap.example-org.test/");
        expect(rdapBaseFor(BOOTSTRAP, "example.zz")).toBeNull();
        expect(rdapBaseFor({ nope: true }, "example.com")).toBeNull();
    });

    it("reads expiry, locks, the registrar and a redacted holder", () => {
        const answer = {
            objectClassName: "domain",
            status: ["client transfer prohibited", "active"],
            events: [{ eventAction: "expiration", eventDate: "2027-04-11T10:00:00Z" }],
            entities: [
                {
                    roles: ["registrar"],
                    vcardArray: ["vcard", [["fn", {}, "text", "Example Registrar"]]]
                },
                {
                    roles: ["registrant"],
                    vcardArray: ["vcard", [["fn", {}, "text", "REDACTED FOR PRIVACY"]]]
                }
            ],
            links: [
                {
                    rel: "related",
                    type: "application/rdap+json",
                    href: "https://rdap.example-registrar.test/domain/example.com"
                }
            ]
        };
        expect(parseRdapDomain(answer)).toEqual({
            expiresAt: "2027-04-11T10:00:00.000Z",
            statuses: ["client transfer prohibited", "active"],
            registrar: "Example Registrar",
            registrantRedacted: true
        });
        expect(relatedRdapLink(answer)).toBe(
            "https://rdap.example-registrar.test/domain/example.com"
        );
    });

    it("sees a published holder, and says nothing when there is no registrant at all", () => {
        const open = parseRdapDomain({
            entities: [
                {
                    roles: ["registrant"],
                    vcardArray: ["vcard", [["fn", {}, "text", "Jane Example"]]]
                }
            ]
        });
        expect(open?.registrantRedacted).toBe(false);
        expect(parseRdapDomain({ entities: [] })?.registrantRedacted).toBeNull();
        expect(parseRdapDomain({ objectClassName: "error" })).toBeNull();
    });

    it("completes a thin registry's answer with the registrar's", () => {
        const registry = {
            expiresAt: "2027-01-01T00:00:00.000Z",
            statuses: ["client transfer prohibited"],
            registrar: "Example Registrar",
            registrantRedacted: null
        };
        const registrar = {
            expiresAt: null,
            statuses: [],
            registrar: null,
            registrantRedacted: true
        };
        expect(mergeRegistration(registry, registrar)).toEqual({
            ...registry,
            registrantRedacted: true
        });
        expect(mergeRegistration(registry, null)).toBe(registry);
    });
});
