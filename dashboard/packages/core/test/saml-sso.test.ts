import { describe, expect, it } from "vitest";
import {
    emailDomain,
    passwordSignInRefused,
    providerForEmail,
    sameOriginPath,
    samlProviderInputSchema,
    samlServiceProviderUrls,
    type SamlDomainPolicy
} from "../src/schemas/saml-sso.js";

const valid = {
    name: "Acme Okta",
    domains: [" Acme.COM ", "@eng.acme.com", "acme.com"],
    source: { kind: "manual", entityId: "http://www.okta.com/exk1", ssoUrl: "https://acme.okta.com/sso/saml", certificate: "MIIC" },
    mapping: { email: "email", name: "displayName", firstName: "", lastName: "surname" },
    allowSignUp: false,
    enforced: true
};

describe("samlProviderInputSchema", () => {
    it("normalizes and deduplicates the domains", () => {
        const parsed = samlProviderInputSchema.parse(valid);
        expect(parsed.domains).toEqual(["acme.com", "eng.acme.com"]);
        expect(parsed.mapping.firstName).toBeUndefined();
    });

    it("refuses a malformed domain, an empty list and too many", () => {
        expect(samlProviderInputSchema.safeParse({ ...valid, domains: ["not a domain"] }).success).toBe(false);
        expect(samlProviderInputSchema.safeParse({ ...valid, domains: [] }).success).toBe(false);
        const many = Array.from({ length: 21 }, (_, i) => `d${i}.example.com`);
        expect(samlProviderInputSchema.safeParse({ ...valid, domains: many }).success).toBe(false);
    });

    it("needs https for the sign-in and metadata addresses", () => {
        const http = { ...valid, source: { ...valid.source, ssoUrl: "http://acme.okta.com/sso" } };
        expect(samlProviderInputSchema.safeParse(http).success).toBe(false);
        const url = { ...valid, source: { kind: "metadataUrl", url: "http://idp.example.com/metadata" } };
        expect(samlProviderInputSchema.safeParse(url).success).toBe(false);
        const ok = { ...valid, source: { kind: "metadataUrl", url: "https://idp.example.com/metadata" } };
        expect(samlProviderInputSchema.safeParse(ok).success).toBe(true);
    });

    it("refuses pasted XML that is not metadata, and an unknown source", () => {
        const xml = { ...valid, source: { kind: "metadataXml", xml: "<html></html>" } };
        expect(samlProviderInputSchema.safeParse(xml).success).toBe(false);
        const md = { ...valid, source: { kind: "metadataXml", xml: '<md:EntityDescriptor entityID="x"></md:EntityDescriptor>' } };
        expect(samlProviderInputSchema.safeParse(md).success).toBe(true);
        expect(samlProviderInputSchema.safeParse({ ...valid, source: { kind: "other" } }).success).toBe(false);
    });

    it("accepts keeping the saved details, which only an edit can use", () => {
        expect(samlProviderInputSchema.safeParse({ ...valid, source: { kind: "current" } }).success).toBe(true);
    });

    it("needs the email and name attributes", () => {
        expect(samlProviderInputSchema.safeParse({ ...valid, mapping: { ...valid.mapping, email: " " } }).success).toBe(false);
    });
});

const providers: SamlDomainPolicy[] = [
    { providerId: "saml-aaaaaaaaaaaa", domains: ["acme.com"], enforced: true, domainVerified: true },
    { providerId: "saml-bbbbbbbbbbbb", domains: ["beta.io"], enforced: true, domainVerified: false },
    { providerId: "saml-cccccccccccc", domains: ["gamma.org"], enforced: false, domainVerified: true }
];

describe("domain routing", () => {
    it("routes an address to the provider of its domain or a parent domain", () => {
        expect(providerForEmail("Ana@ACME.com", providers)?.providerId).toBe("saml-aaaaaaaaaaaa");
        expect(providerForEmail("ana@eng.acme.com", providers)?.providerId).toBe("saml-aaaaaaaaaaaa");
        expect(providerForEmail("ana@notacme.com", providers)).toBeNull();
        expect(providerForEmail("not-an-email", providers)).toBeNull();
        expect(emailDomain("a@b")).toBeNull();
    });
});

describe("passwordSignInRefused", () => {
    it("refuses a password for an enforced, verified domain", () => {
        expect(passwordSignInRefused({ email: "ana@acme.com", isAdmin: false }, providers)).toBe(true);
    });

    it("keeps the password for a platform administrator (break-glass)", () => {
        expect(passwordSignInRefused({ email: "root@acme.com", isAdmin: true }, providers)).toBe(false);
    });

    it("does not enforce an unverified or optional provider, or another domain", () => {
        expect(passwordSignInRefused({ email: "ana@beta.io", isAdmin: false }, providers)).toBe(false);
        expect(passwordSignInRefused({ email: "ana@gamma.org", isAdmin: false }, providers)).toBe(false);
        expect(passwordSignInRefused({ email: "ana@other.net", isAdmin: false }, providers)).toBe(false);
    });
});

describe("sameOriginPath", () => {
    it("keeps a same-origin path", () => {
        expect(sameOriginPath("/drive?x=1#top")).toBe("/drive?x=1#top");
    });

    it("refuses every way off the deployment", () => {
        for (const target of ["https://evil.example", "//evil.example", "/\\evil.example", "\\\\evil", "javascript:alert(1)", "", null, undefined, "evil.example/x", "/%2F%2Fevil"]) {
            const result = sameOriginPath(target);
            if (result !== null) expect(result.startsWith("//")).toBe(false);
            if (typeof target === "string" && !target.startsWith("/%2F")) expect(result).toBeNull();
        }
    });
});

describe("samlServiceProviderUrls", () => {
    it("derives the entity ID and ACS from the app address", () => {
        const urls = samlServiceProviderUrls("https://polaris.example.com/", "saml-aaaaaaaaaaaa");
        expect(urls.acsUrl).toBe("https://polaris.example.com/api/auth/sso/saml2/sp/acs/saml-aaaaaaaaaaaa");
        expect(urls.entityId).toBe("https://polaris.example.com/api/auth/sso/saml2/sp/metadata?providerId=saml-aaaaaaaaaaaa");
    });
});
