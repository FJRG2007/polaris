/**
 * The Domains page's typed fields, read the same way by the page and by the save:
 * a sharing domain of `////` used to be stored as typed, and every link Polaris
 * handed out after that read `https://`.
 */

import { describe, expect, it } from "vitest";
import {
    baseDomainField,
    baseDomainSchema,
    duckSubdomainField,
    siteAddressField,
    siteAddressSchema
} from "@/lib/domain-fields";

describe("the app and sharing domain", () => {
    it("refuses what is not an address", () => {
        for (const typed of ["////", "/", "https://", "share", "a b.com", "x.com/path", "-x.com", "x..com", "x.com:99999"])
            expect(siteAddressField(typed).ok, typed).toBe(false);
    });

    it("takes a domain, an IP or localhost, with the scheme and port people paste", () => {
        expect(siteAddressField("polaris.example.com")).toEqual({ value: "polaris.example.com", ok: true });
        expect(siteAddressField("  HTTPS://Share.Example.com/ ")).toEqual({ value: "share.example.com", ok: true });
        expect(siteAddressField("polaris.example.com.")).toEqual({ value: "polaris.example.com", ok: true });
        expect(siteAddressField("http://192.168.1.20:3000")).toEqual({ value: "http://192.168.1.20:3000", ok: true });
        expect(siteAddressField("localhost:3000")).toEqual({ value: "localhost:3000", ok: true });
        expect(siteAddressField("abc.traefik.me")).toEqual({ value: "abc.traefik.me", ok: true });
    });

    it("lets the field be emptied, which falls back to the default", () => {
        expect(siteAddressField("   ")).toEqual({ value: "", ok: true });
    });

    it("is refused by the save as well, and stored normalized", () => {
        expect(siteAddressSchema.safeParse("////").success).toBe(false);
        expect(siteAddressSchema.parse("https://share.example.com/")).toBe("share.example.com");
        expect(siteAddressSchema.parse("")).toBe("");
    });
});

describe("the DuckDNS name", () => {
    it("takes the name pasted whole, and refuses anything that is not one label", () => {
        expect(duckSubdomainField("MyPolaris.duckdns.org")).toEqual({ value: "mypolaris", ok: true });
        expect(duckSubdomainField("my.polaris").ok).toBe(false);
        expect(duckSubdomainField("my_polaris").ok).toBe(false);
        expect(duckSubdomainField("").ok).toBe(true);
        expect(duckSubdomainField("////").ok).toBe(false);
    });
});

describe("a base domain", () => {
    it("drops a wildcard prefix and a scheme, and needs two labels", () => {
        expect(baseDomainField("https://*.apps.example.com/")).toEqual({ value: "apps.example.com", ok: true });
        expect(baseDomainField("apps").ok).toBe(false);
        // Typed but nothing left once normalized: refused, not saved as a cleared field.
        expect(baseDomainField("////").ok).toBe(false);
        expect(baseDomainField("").ok).toBe(true);
        expect(baseDomainSchema.safeParse("apps..example.com").success).toBe(false);
    });
});
