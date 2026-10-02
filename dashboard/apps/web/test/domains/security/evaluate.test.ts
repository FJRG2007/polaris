/**
 * Judging a domain from its facts: every check's verdict, the record each fix
 * publishes, and the grade. No network - the facts are fixtures.
 */

import { facts } from "./facts";
import { describe, expect, it } from "vitest";
import { evaluate } from "@/lib/domain-security/evaluate";
import type { Finding } from "@/lib/domain-security/types";

const NOW = new Date("2026-10-02T12:00:00.000Z");

function codes(findings: readonly Finding[]): string[] {
    return findings.map((finding) => finding.code);
}

function find(findings: readonly Finding[], code: string): Finding | undefined {
    return findings.find((finding) => finding.code === code);
}

describe("a well set-up domain", () => {
    it("passes everything and is protected", () => {
        const report = evaluate(facts(), NOW);
        expect(report.findings.filter((finding) => finding.severity !== "pass")).toEqual([]);
        expect(report.grade).toBe("protected");
        expect(report.sends).toBe(true);
        expect(report.receives).toBe(true);
        expect(report.rua).toEqual(["mailto:dmarc@example.com"]);
    });
});

describe("email", () => {
    it("locks down a domain that sends and takes no mail", () => {
        const report = evaluate(facts({ mx: [], apexTxt: [], dmarcTxt: [], dkim: [], mtaStsTxt: [], tlsRptTxt: [] }), NOW);
        expect(report.sends).toBe(false);
        expect(find(report.findings, "spfMissing")).toMatchObject({ severity: "high", records: [{ type: "TXT", name: "example.com", value: "v=spf1 -all" }] });
        expect(find(report.findings, "dmarcMissing")?.records[0]?.value).toBe("v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s");
        expect(find(report.findings, "parkedNullMx")?.records[0]).toEqual({ type: "MX", name: "example.com", value: ".", priority: 0 });
        expect(find(report.findings, "parkedDkim")?.records[0]).toEqual({ type: "TXT", name: "*._domainkey.example.com", value: "v=DKIM1; p=" });
        // MTA-STS and TLS reports are about receiving: not asked of a domain that takes no mail.
        expect(codes(report.findings)).not.toContain("mtaStsMissing");
        expect(report.grade).toBe("exposed");
    });

    it("recognizes a domain already locked down", () => {
        const report = evaluate(
            facts({
                mx: [{ priority: 0, exchange: "" }],
                apexTxt: ["v=spf1 -all"],
                spfWalk: { lookups: 0, voids: 0, missing: [], broken: [] },
                dmarcTxt: ["v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s; rua=mailto:r@example.com"],
                dkim: [{ selector: "*", text: "v=DKIM1; p=", bits: null }]
            }),
            NOW
        );
        expect(codes(report.findings)).toEqual(expect.arrayContaining(["mxNull", "parkedOk", "dmarcOk"]));
        expect(codes(report.findings)).not.toContain("parkedDkim");
    });

    it("starts a sending domain's DMARC at none, with reports to Polaris when it reads them", () => {
        const report = evaluate(facts({ dmarcTxt: [], context: { ...facts().context, reportAddress: "dmarc-reports@example.com" } }), NOW);
        expect(find(report.findings, "dmarcMissing")?.records[0]?.value).toBe("v=DMARC1; p=none; rua=mailto:dmarc-reports@example.com");
    });

    it("grades every way an SPF breaks", () => {
        expect(find(evaluate(facts({ apexTxt: ["v=spf1 -all", "v=spf1 mx -all"] }), NOW).findings, "spfMultiple")?.severity).toBe("critical");
        expect(find(evaluate(facts({ apexTxt: ["v=spf1 +all"] }), NOW).findings, "spfAllPass")?.severity).toBe("critical");
        expect(find(evaluate(facts({ apexTxt: ["v=spf1 mx ?all"] }), NOW).findings, "spfAllNeutral")?.severity).toBe("high");
        expect(find(evaluate(facts({ apexTxt: ["v=spf1 mx"] }), NOW).findings, "spfAllMissing")?.severity).toBe("medium");
        expect(find(evaluate(facts({ apexTxt: ["v=spf1 mx ~all"] }), NOW).findings, "spfAllSoft")?.severity).toBe("low");
        expect(find(evaluate(facts({ apexTxt: ["v=spf1 nope -all"] }), NOW).findings, "spfSyntax")?.params).toEqual({ term: "nope" });
        const walked = evaluate(facts({ spfWalk: { lookups: 12, voids: 3, missing: ["gone.example"], broken: [] } }), NOW).findings;
        expect(codes(walked)).toEqual(expect.arrayContaining(["spfLookups", "spfVoid", "spfIncludeMissing"]));
        expect(codes(walked)).not.toContain("spfOk");
    });

    it("grades DMARC policies one step at a time", () => {
        const none = evaluate(facts({ dmarcTxt: ["v=DMARC1; p=none; rua=mailto:d@example.com"] }), NOW).findings;
        expect(find(none, "dmarcNone")).toMatchObject({ severity: "medium", records: [{ value: "v=DMARC1; p=quarantine; rua=mailto:d@example.com" }] });
        const weak = evaluate(facts({ dmarcTxt: ["v=DMARC1; p=reject; sp=none; pct=50"] }), NOW).findings;
        expect(codes(weak)).toEqual(expect.arrayContaining(["dmarcPct", "dmarcSubdomainWeaker", "dmarcRuaMissing"]));
        expect(find(evaluate(facts({ dmarcTxt: ["v=DMARC1; p=reject", "v=DMARC1; p=none"] }), NOW).findings, "dmarcMultiple")?.severity).toBe("critical");
    });

    it("flags a report address outside the domain that did not authorize its reports", () => {
        const findings = evaluate(facts({ ruaAuthorization: { "reports.example.net": false, "ok.example.org": true } }), NOW).findings;
        expect(findings.filter((finding) => finding.code === "dmarcRuaUnauthorized").map((finding) => finding.params.host)).toEqual(["reports.example.net"]);
    });

    it("weighs DKIM keys by size", () => {
        const findings = evaluate(
            facts({
                dkim: [
                    { selector: "old", text: "v=DKIM1; p=AAAA", bits: 512 },
                    { selector: "mid", text: "v=DKIM1; t=y; p=BBBB", bits: 1024 }
                ]
            }),
            NOW
        ).findings;
        expect(find(findings, "dkimWeak")?.params).toEqual({ selector: "old", bits: 512 });
        expect(find(findings, "dkimShort")?.params).toEqual({ selector: "mid", bits: 1024 });
        expect(find(findings, "dkimTesting")?.params).toEqual({ selector: "mid" });
    });

    it("says an MTA-STS policy that would stop delivery to a listed MX", () => {
        const findings = evaluate(facts({ mx: [{ priority: 10, exchange: "mx.example.net" }, { priority: 20, exchange: "backup.example.org" }] }), NOW).findings;
        expect(find(findings, "mtaStsMxMismatch")).toMatchObject({ severity: "high", params: { hosts: "backup.example.org" } });
    });

    it("says nothing about SPF it could not read", () => {
        expect(codes(evaluate(facts({ apexTxt: null }), NOW).findings)).toContain("spfUnchecked");
        expect(codes(evaluate(facts({ apexTxt: null }), NOW).findings)).not.toContain("spfMissing");
    });
});

describe("DNS", () => {
    it("tells the DNSSEC states apart", () => {
        expect(find(evaluate(facts({ dnssec: { ds: false, dnskey: false, validated: null } }), NOW).findings, "dnssecOff")?.where).toBe("dnssec");
        const unanchored = evaluate(
            facts({ dnssec: { ds: false, dnskey: true, validated: null }, context: { ...facts().context, dsRecord: "2371 13 2 ABCD" } }),
            NOW
        ).findings;
        expect(find(unanchored, "dnssecNoDs")).toMatchObject({ severity: "medium", where: "registrar", records: [{ type: "DS", value: "2371 13 2 ABCD" }] });
        expect(find(evaluate(facts({ dnssec: { ds: true, dnskey: true, validated: false } }), NOW).findings, "dnssecBroken")?.severity).toBe("high");
        expect(codes(evaluate(facts({ dnssec: { ds: null, dnskey: null, validated: null } }), NOW).findings)).not.toEqual(
            expect.arrayContaining(["dnssecOff"])
        );
    });

    it("warns when CAA would refuse the certificates Polaris orders", () => {
        const findings = evaluate(facts({ caa: [{ flags: 0, tag: "issue", value: "digicert.com" }] }), NOW).findings;
        expect(find(findings, "caaBlocksPolaris")).toMatchObject({ severity: "high", records: [{ type: "CAA", value: '0 issue "letsencrypt.org"' }] });
        const missing = evaluate(facts({ caa: [] }), NOW).findings;
        expect(find(missing, "caaMissing")?.records).toHaveLength(1);
    });

    it("grades name servers, transfers, dangling aliases and wildcards", () => {
        const findings = evaluate(
            facts({
                ns: [
                    { name: "a.example.net", addresses: ["192.0.2.1"] },
                    { name: "b.example.net", addresses: ["192.0.2.2"] }
                ],
                axfr: [{ server: "a.example.net", open: true }],
                dangling: [{ name: "old.example.com", target: "gone.example.org" }],
                wildcard: true
            }),
            NOW
        ).findings;
        expect(find(findings, "nsSameNetwork")?.params).toEqual({ block: "192.0.2.0/24" });
        expect(find(findings, "axfrOpen")?.severity).toBe("high");
        expect(find(findings, "danglingCname")?.params).toEqual({ name: "old.example.com", target: "gone.example.org" });
        expect(find(findings, "wildcard")?.severity).toBe("low");
    });
});

describe("registration", () => {
    it("warns more the closer the expiry", () => {
        const at = (date: string) => find(evaluate(facts({ registration: { ...facts().registration!, expiresAt: date } }), NOW).findings, "expirySoon")?.severity;
        expect(at("2026-10-10T00:00:00.000Z")).toBe("critical");
        expect(at("2026-10-25T00:00:00.000Z")).toBe("high");
        expect(at("2026-11-20T00:00:00.000Z")).toBe("medium");
        expect(at("2027-06-01T00:00:00.000Z")).toBeUndefined();
    });

    it("asks for a transfer lock and privacy", () => {
        const findings = evaluate(facts({ registration: { expiresAt: null, statuses: ["active"], registrar: "Example Registrar", registrantRedacted: false } }), NOW).findings;
        expect(codes(findings)).toEqual(expect.arrayContaining(["transferUnlocked", "registrantPublic"]));
        expect(codes(evaluate(facts({ registration: null }), NOW).findings)).toContain("rdapUnavailable");
    });
});

describe("web", () => {
    it("asks for the headers a site is missing, on Polaris's edge when Polaris serves it", () => {
        const findings = evaluate(
            facts({ web: { ...facts().web!, headers: {}, servedByPolaris: true, httpRedirects: false, legacyProtocol: "TLSv1" } }),
            NOW
        ).findings;
        expect(find(findings, "hstsMissing")?.where).toBe("edge");
        expect(find(findings, "headerFramingMissing")?.severity).toBe("medium");
        expect(codes(findings)).toEqual(expect.arrayContaining(["headerNosniffMissing", "headerReferrerMissing", "headerCspMissing", "httpRedirectMissing", "tlsLegacy"]));
    });

    it("grades a certificate that is not trusted or about to lapse", () => {
        const untrusted = evaluate(facts({ web: { ...facts().web!, certificate: { issuer: "X", validTo: "2027-01-01T00:00:00.000Z", trusted: false, error: "CERT_HAS_EXPIRED" } } }), NOW);
        expect(find(untrusted.findings, "certInvalid")?.params.reason).toBe("CERT_HAS_EXPIRED");
        const soon = evaluate(facts({ web: { ...facts().web!, certificate: { issuer: "X", validTo: "2026-10-10T00:00:00.000Z", trusted: true, error: null } } }), NOW);
        expect(find(soon.findings, "certExpiring")?.severity).toBe("high");
    });

    it("says there is no site rather than that the site is broken", () => {
        expect(codes(evaluate(facts({ web: null }), NOW).findings)).toContain("webNone");
    });
});
