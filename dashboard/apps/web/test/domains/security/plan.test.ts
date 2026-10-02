/**
 * What Polaris would change in a zone, before it changes anything: one SPF
 * always, nothing published replaced without showing it, DMARC tightened only
 * when somebody chose to, CAA added to rather than rewritten.
 */

import { facts } from "./facts";
import { describe, expect, it } from "vitest";
import { evaluate } from "@/lib/domain-security/evaluate";
import { automaticChanges, fingerprint, planChanges, type PlanInput, type ZoneRecordLike } from "@/lib/domain-security/plan";

const NOW = new Date("2026-10-02T12:00:00.000Z");
const ID = (n: number) => n.toString(16).padStart(32, "0");

function plan(overrides: Partial<PlanInput> & { facts?: Parameters<typeof facts>[0] }) {
    const { facts: changes, ...rest } = overrides;
    return planChanges({
        report: evaluate(facts(changes), NOW),
        records: [],
        canSign: false,
        edge: [],
        reportAddress: null,
        dmarcPolicy: null,
        ...rest
    });
}

describe("planning fixes", () => {
    it("locks down a parked domain in one go", () => {
        const changes = plan({ facts: { mx: [], apexTxt: [], dmarcTxt: [], dkim: [], caa: [] } });
        expect(changes.map((change) => [change.action, change.type, change.name, change.after])).toEqual([
            ["create", "TXT", "example.com", "v=spf1 -all"],
            ["create", "TXT", "_dmarc.example.com", "v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s"],
            ["create", "MX", "example.com", "."],
            ["create", "TXT", "*._domainkey.example.com", "v=DKIM1; p="],
            ["create", "CAA", "example.com", '0 issue "letsencrypt.org"']
        ]);
    });

    it("merges two SPF records into the first and removes the other, showing both", () => {
        const records: ZoneRecordLike[] = [
            { id: ID(1), type: "TXT", name: "example.com", content: '"v=spf1 include:a.example -all"' },
            { id: ID(2), type: "TXT", name: "example.com", content: "v=spf1 include:b.example ~all" }
        ];
        const changes = plan({ facts: { apexTxt: ["v=spf1 include:a.example -all", "v=spf1 include:b.example ~all"] }, records });
        expect(changes).toEqual([
            expect.objectContaining({ action: "update", recordId: ID(1), before: ["v=spf1 include:a.example -all"], after: "v=spf1 include:a.example include:b.example -all" }),
            expect.objectContaining({ action: "delete", recordId: ID(2), before: ["v=spf1 include:b.example ~all"], after: null })
        ]);
    });

    it("never moves DMARC past none unless a policy was chosen", () => {
        const records: ZoneRecordLike[] = [{ id: ID(3), type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1; p=none; rua=mailto:d@example.com" }];
        const base = { facts: { dmarcTxt: ["v=DMARC1; p=none; rua=mailto:d@example.com"] }, records };
        expect(plan(base)).toEqual([]);
        expect(plan({ ...base, dmarcPolicy: "reject" })).toEqual([
            expect.objectContaining({ action: "update", code: "dmarcNone", after: "v=DMARC1; p=reject; rua=mailto:d@example.com" })
        ]);
    });

    it("adds Polaris's report address to a DMARC that asks for none", () => {
        const records: ZoneRecordLike[] = [{ id: ID(4), type: "TXT", name: "_dmarc.example.com", content: "v=DMARC1; p=reject" }];
        const changes = plan({ facts: { dmarcTxt: ["v=DMARC1; p=reject"] }, records, reportAddress: "dmarc-reports@example.com" });
        expect(changes).toEqual([expect.objectContaining({ code: "dmarcRuaMissing", after: "v=DMARC1; p=reject; rua=mailto:dmarc-reports@example.com" })]);
    });

    it("adds a CAA issuer alongside the ones there, and leaves an MX alone", () => {
        const records: ZoneRecordLike[] = [
            { id: ID(5), type: "CAA", name: "example.com", content: '0 issue "digicert.com"' },
            { id: ID(6), type: "MX", name: "example.com", content: "mx.example.net", priority: 10 }
        ];
        const changes = plan({ facts: { caa: [{ flags: 0, tag: "issue", value: "digicert.com" }] }, records });
        expect(changes).toEqual([expect.objectContaining({ action: "create", type: "CAA", before: ['0 issue "digicert.com"'], after: '0 issue "letsencrypt.org"' })]);
    });

    it("plans nothing in a zone it cannot read, but still DNSSEC and edge headers", () => {
        const changes = plan({
            facts: { apexTxt: [], dnssec: { ds: false, dnskey: false, validated: null }, web: { ...facts().web!, headers: {}, servedByPolaris: true } },
            records: null,
            canSign: true,
            edge: [
                { applicationId: "app-1", hostname: "example.com", preset: "off" },
                { applicationId: "app-2", hostname: "www.example.com", preset: "strict" }
            ]
        });
        expect(changes.map((change) => change.kind)).toEqual(["dnssec", "edge"]);
        expect(changes[1]).toMatchObject({ applicationId: "app-1", before: ["off"], after: "recommended" });
        // A dedicated domain's automatic pass changes the zone, never somebody's service.
        expect(automaticChanges(changes).map((change) => change.kind)).toEqual(["dnssec"]);
    });

    it("leaves a null MX on a sending domain and a first CAA record to a person", () => {
        const changes = plan({ facts: { mx: [], caa: [] } });
        expect(changes.map((change) => change.code)).toEqual(["mxMissing", "caaMissing"]);
        expect(automaticChanges(changes)).toEqual([]);
        const parked = plan({ facts: { mx: [], apexTxt: [], dmarcTxt: [], dkim: [] } });
        expect(automaticChanges(parked).map((change) => change.code)).toContain("parkedNullMx");
    });

    it("fingerprints a change by what it shows, so a moved plan is refused", () => {
        const [change] = plan({ facts: { apexTxt: [] } });
        expect(fingerprint(change!)).toBe(fingerprint({ ...change! }));
        expect(fingerprint(change!)).not.toBe(fingerprint({ ...change!, after: "v=spf1 ~all" }));
    });
});
