/**
 * Polaris decides by itself when a DMARC policy can move one step stricter,
 * from the reports it reads: a calm status while it waits, an actionable item
 * once it is safe or once a real sender fails, and a plain statement when the
 * reports never reach it.
 */

import { facts } from "./facts";
import type * as core from "@polaris/core";
import { describe, expect, it } from "vitest";
import { evaluate } from "@/lib/domain-security/evaluate";
import { regressions } from "@/lib/domain-security/types";
import {
    dmarcReadiness,
    READY_DAYS,
    withReadiness,
    type DmarcReadiness
} from "@/lib/domain-security/dmarc-advice";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00.000Z");
const POLARIS = "dmarc-reports@example.com";
const REACHES = [`mailto:${POLARIS}`];

type RowKind = "pass" | "misconfigured" | "spoofing";

function row(kind: RowKind, sourceIp = "192.0.2.10"): core.DmarcRow {
    return {
        sourceIp,
        count: 5,
        disposition: "none",
        dkim: kind === "pass" ? "pass" : "fail",
        spf: "fail",
        headerFrom: "example.com",
        authDkim:
            kind === "spoofing"
                ? []
                : [
                      {
                          domain: kind === "pass" ? "example.com" : "mailer.example.net",
                          result: "pass",
                          selector: "s1"
                      }
                  ],
        authSpf: []
    };
}

/** One daily report that ended `ago` days before NOW. */
function report(ago: number, rows: core.DmarcRow[]): core.DmarcReport {
    const end = new Date(NOW.getTime() - ago * DAY);
    return {
        orgName: "receiver.example.net",
        reportId: `r-${ago}`,
        email: "noreply@receiver.example.net",
        begin: new Date(end.getTime() - DAY),
        end,
        domain: "example.com",
        policy: { p: "none", sp: "none", pct: 100 },
        rows
    };
}

function daily(days: number, rows: core.DmarcRow[]): core.DmarcReport[] {
    return Array.from({ length: days }, (_, index) => report(index, rows));
}

function readiness(
    reports: core.DmarcReport[],
    rua = REACHES,
    reportAddress: string | null = POLARIS
) {
    return dmarcReadiness({ reportAddress, rua, reports, now: NOW });
}

describe("dmarcReadiness", () => {
    it("says plainly when Polaris has no mailbox for the domain's reports", () => {
        expect(readiness([], ["mailto:dmarc@reports.example.net"], null)).toEqual({
            kind: "unread"
        });
    });

    it("offers Polaris's own address when the record sends reports elsewhere", () => {
        expect(readiness([], ["mailto:dmarc@reports.example.net"])).toEqual({
            kind: "noReports",
            address: POLARIS
        });
    });

    it("waits quietly when reports are on their way but none has arrived", () => {
        expect(readiness([])).toEqual({ kind: "collecting", days: 0 });
    });

    it("is not ready until every sender has passed for the whole window", () => {
        expect(readiness(daily(5, [row("pass")]))).toEqual({ kind: "collecting", days: 5 });
    });

    it("is ready once every sender passed for the window", () => {
        expect(readiness(daily(READY_DAYS, [row("pass")]))).toEqual({ kind: "ready" });
    });

    it("does not let forged mail hold the step back", () => {
        expect(readiness(daily(READY_DAYS, [row("pass"), row("spoofing", "203.0.113.9")]))).toEqual(
            {
                kind: "ready"
            }
        );
    });

    it("names the real sender that fails instead of the policy", () => {
        const result = readiness(
            daily(READY_DAYS, [row("pass"), row("misconfigured", "198.51.100.7")])
        );
        expect(result.kind).toBe("failing");
        expect(
            result.kind === "failing" && result.senders.map((sender) => sender.sourceIp)
        ).toEqual(["198.51.100.7"]);
    });

    it("forgets a failure older than the window once the sender was fixed", () => {
        const reports = [...daily(READY_DAYS, [row("pass")]), report(20, [row("misconfigured")])];
        expect(readiness(reports)).toEqual({ kind: "ready" });
    });

    it("does not decide from old reports once the record stops sending them here", () => {
        const reports = Array.from({ length: 20 }, (_, index) => report(index + 10, [row("pass")]));
        expect(readiness(reports, ["mailto:dmarc@reports.example.net"])).toEqual({
            kind: "noReports",
            address: POLARIS
        });
    });

    it("is not ready when recent reports stopped arriving", () => {
        const reports = Array.from({ length: 20 }, (_, index) => report(index + 10, [row("pass")]));
        expect(readiness(reports)).toEqual({ kind: "collecting", days: 0 });
    });

    it("counts only the days since the last gap in reports", () => {
        const reports = [
            ...daily(4, [row("pass")]),
            ...Array.from({ length: 10 }, (_, index) => report(index + 10, [row("pass")]))
        ];
        expect(readiness(reports)).toEqual({ kind: "collecting", days: 4 });
    });
});

describe("withReadiness", () => {
    const monitoring = evaluate(
        facts({ dmarcTxt: [`v=DMARC1; p=none; rua=mailto:${POLARIS}`] }),
        NOW
    );
    const policyOf = (findings: readonly { code: string }[]) =>
        findings.find((finding) => finding.code === "dmarcNone");

    it("keeps a policy that is still collecting as a calm status with no fix and no alert", () => {
        const before = { ...monitoring, findings: [] };
        const after = withReadiness(monitoring, { kind: "collecting", days: 3 });
        expect(policyOf(after.findings)).toMatchObject({
            severity: "info",
            records: [],
            params: { state: "collecting", days: 3, left: READY_DAYS - 3 }
        });
        expect(regressions(before.findings, after.findings)).toEqual([]);
        expect(after.grade).toBe("protected");
    });

    for (const kind of ["unread", "noReports"] as const) {
        it(`does not alert about the policy when reports do not reach Polaris (${kind})`, () => {
            const state: DmarcReadiness = kind === "unread" ? { kind } : { kind, address: POLARIS };
            const after = withReadiness(monitoring, state);
            expect(policyOf(after.findings)).toMatchObject({
                severity: "info",
                params: { state: kind }
            });
            expect(regressions(null, after.findings).map((finding) => finding.code)).not.toContain(
                "dmarcNone"
            );
        });
    }

    it("raises the policy as the one actionable item once it is ready, with the stricter record", () => {
        const before = withReadiness(monitoring, { kind: "collecting", days: 13 });
        const after = withReadiness(monitoring, { kind: "ready" });
        const policy = policyOf(after.findings);
        expect(policy).toMatchObject({
            severity: "medium",
            params: { state: "ready", to: "quarantine" }
        });
        expect(policy && "records" in policy && policy.records).toEqual([
            expect.objectContaining({ value: expect.stringContaining("p=quarantine") })
        ]);
        expect(regressions(before.findings, after.findings).map((finding) => finding.code)).toEqual(
            ["dmarcNone"]
        );
    });

    it("makes each failing sender its own actionable finding", () => {
        const failing = readiness(daily(READY_DAYS, [row("misconfigured", "198.51.100.7")]));
        const after = withReadiness(monitoring, failing);
        expect(after.findings.filter((finding) => finding.code === "dmarcSenderFailing")).toEqual([
            expect.objectContaining({
                severity: "medium",
                params: expect.objectContaining({
                    name: "198.51.100.7",
                    host: "198.51.100.7",
                    failed: 70
                })
            })
        ]);
        expect(policyOf(after.findings)).toMatchObject({
            severity: "info",
            params: { state: "failing" }
        });
    });
});

describe("reports that go somewhere Polaris does not read", () => {
    it("is a finding with the record that adds Polaris's address", () => {
        const report = evaluate(
            facts({
                dmarcTxt: ["v=DMARC1; p=none; rua=mailto:dmarc@reports.example.net"],
                context: { ...facts().context, reportAddress: POLARIS }
            }),
            NOW
        );
        expect(
            report.findings.find((finding) => finding.code === "dmarcReportsElsewhere")
        ).toMatchObject({
            severity: "low",
            where: "dns",
            records: [
                expect.objectContaining({
                    value: `v=DMARC1; p=none; rua=mailto:dmarc@reports.example.net,mailto:${POLARIS}`
                })
            ]
        });
    });

    it("is not raised once the record already names Polaris", () => {
        const report = evaluate(
            facts({
                dmarcTxt: [
                    `v=DMARC1; p=none; rua=mailto:dmarc@reports.example.net,mailto:${POLARIS}`
                ],
                context: { ...facts().context, reportAddress: POLARIS }
            }),
            NOW
        );
        expect(report.findings.map((finding) => finding.code)).not.toContain(
            "dmarcReportsElsewhere"
        );
    });
});
