/**
 * A domain's facts for a test: a well set-up sending domain by default, with
 * whatever the test is about overridden. Every value is fixture data on the
 * reserved `example` names and documentation addresses.
 */

import type { DomainFacts } from "@/lib/domain-security/facts";

export function facts(overrides: Partial<DomainFacts> = {}): DomainFacts {
    return {
        domain: "example.com",
        mx: [{ priority: 10, exchange: "mx.example.net" }],
        apexTxt: ["v=spf1 include:_spf.example.net -all"],
        spfWalk: { lookups: 2, voids: 0, missing: [], broken: [] },
        dmarcTxt: ["v=DMARC1; p=reject; rua=mailto:dmarc@example.com"],
        ruaAuthorization: {},
        dkim: [{ selector: "s1", text: "v=DKIM1; k=rsa; p=MIIBIjAN", bits: 2048 }],
        dkimSelectorsTried: ["default", "s1"],
        mtaStsTxt: ["v=STSv1; id=20260101"],
        mtaStsPolicy: {
            status: "ok",
            text: "version: STSv1\nmode: enforce\nmx: mx.example.net\nmax_age: 604800\n"
        },
        tlsRptTxt: ["v=TLSRPTv1; rua=mailto:tls@example.com"],
        bimiTxt: [],
        dnssec: { ds: true, dnskey: true, validated: true },
        caa: [{ flags: 0, tag: "issue", value: "letsencrypt.org" }],
        ns: [
            { name: "ns1.example.net", addresses: ["192.0.2.1"] },
            { name: "ns2.example.org", addresses: ["198.51.100.1"] }
        ],
        axfr: [
            { server: "ns1.example.net", open: false },
            { server: "ns2.example.org", open: false }
        ],
        dangling: [],
        danglingChecked: 1,
        wildcard: false,
        registration: {
            expiresAt: "2028-01-01T00:00:00.000Z",
            statuses: ["client transfer prohibited"],
            registrar: "Example Registrar",
            registrantRedacted: true
        },
        web: {
            certificate: {
                issuer: "Example CA",
                validTo: "2027-06-01T00:00:00.000Z",
                trusted: true,
                error: null
            },
            httpsError: null,
            protocol: "TLSv1.3",
            legacyProtocol: null,
            httpRedirects: true,
            headers: {
                "strict-transport-security": "max-age=31536000; includeSubDomains",
                "content-security-policy": "default-src 'self'; frame-ancestors 'self'",
                "x-content-type-options": "nosniff",
                "referrer-policy": "strict-origin-when-cross-origin"
            },
            securityTxt: {
                status: "ok",
                text: "Contact: mailto:security@example.com\nExpires: 2027-12-31T00:00:00Z\n"
            },
            servedByPolaris: false
        },
        context: {
            polarisIssues: true,
            polarisZone: false,
            mailServerSpf: null,
            reportAddress: null,
            dsRecord: null
        },
        ...overrides
    };
}
