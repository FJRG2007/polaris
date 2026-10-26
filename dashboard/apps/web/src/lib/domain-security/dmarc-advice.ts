/**
 * Whether a domain's DMARC policy can safely move one step stricter, decided by
 * Polaris from the aggregate reports it reads rather than left to somebody
 * reading them by hand.
 *
 * The order that does not lose real mail: every real sender passes alignment
 * first, for long enough that a weekly or fortnightly sender has shown up, then
 * one step stricter. Until then the policy is a calm status, not an alert - the
 * only things worth telling somebody about are a sender they can fix now, and
 * the moment tightening is safe. Pure.
 */

import type * as core from "@polaris/core";
import { gradeOf, type Finding, type SecurityReport } from "./types";
import { sendingSources, type SendingSource } from "./dmarc-sources";

const DAY = 24 * 60 * 60 * 1000;

/**
 * Days of reports, every real sender passing, before a stricter policy is
 * recommended. Google's DMARC rollout guide (support.google.com/a/answer/10032473)
 * says to start at p=none and move up only once daily reports show every
 * legitimate source passing; two weeks of that covers senders that only mail
 * weekly, which is the monitoring phase most rollout plans converge on.
 */
export const READY_DAYS = 14;

/** Failing senders listed as findings, worst first; the senders list has the rest. */
export const MAX_SENDER_FINDINGS = 5;

export type DmarcReadiness =
    /** Every real sender passed for READY_DAYS: the next step is safe. */
    | { readonly kind: "ready" }
    /** Real senders that fail: each is the thing to fix, not the policy. */
    | { readonly kind: "failing"; readonly senders: readonly SendingSource[] }
    /** Reports arrive and pass, but not for long enough yet. */
    | { readonly kind: "collecting"; readonly days: number }
    /** Polaris could read the reports but the record does not send them here. */
    | { readonly kind: "noReports"; readonly address: string }
    /** Polaris has no mailbox that receives this domain's reports. */
    | { readonly kind: "unread" };

/** A `rua` entry as a bare address: no scheme, no size limit, lowercase. */
export function ruaAddress(uri: string): string {
    return uri
        .trim()
        .replace(/^mailto:/i, "")
        .replace(/!\d+[kmgt]?$/i, "")
        .toLowerCase();
}

export function dmarcReadiness(input: {
    /** Polaris's own reports mailbox for the domain, when it has one. */
    readonly reportAddress: string | null;
    /** The `rua` the published record names. */
    readonly rua: readonly string[];
    /** The reports filed for the domain over the last month. */
    readonly reports: readonly core.DmarcReport[];
    readonly now: Date;
}): DmarcReadiness {
    const { reportAddress, reports, now } = input;
    if (!reportAddress) return { kind: "unread" };
    const reaches = input.rua.map(ruaAddress).includes(reportAddress.toLowerCase());
    if (reports.length === 0)
        return reaches
            ? { kind: "collecting", days: 0 }
            : { kind: "noReports", address: reportAddress };
    const windowStart = now.getTime() - READY_DAYS * DAY;
    const recent = reports.filter((report) => report.end.getTime() >= windowStart);
    // Spoofing is exactly what a stricter policy refuses; only a real sender
    // that fails holds the step back.
    const failing = sendingSources(recent).filter((source) => source.verdict === "misconfigured");
    if (failing.length > 0) return { kind: "failing", senders: failing };
    const seen = recent.some((report) => report.rows.some((row) => row.count > 0));
    if (!seen)
        return reaches
            ? { kind: "collecting", days: 0 }
            : { kind: "noReports", address: reportAddress };
    const earliest = Math.min(...reports.map((report) => report.begin.getTime()));
    const days = Math.max(0, Math.floor((now.getTime() - earliest) / DAY));
    return days >= READY_DAYS ? { kind: "ready" } : { kind: "collecting", days };
}

/**
 * The audit's findings with the readiness folded in. The policy finding is a
 * calm `info` status until tightening is safe, when it becomes the one medium
 * item ("ready to tighten") with the stricter record as its fix; each failing
 * real sender becomes its own medium finding naming it. The grade follows.
 */
export function withReadiness(report: SecurityReport, readiness: DmarcReadiness): SecurityReport {
    const findings: Finding[] = report.findings.map((finding) => {
        if (finding.code !== "dmarcNone" && finding.code !== "dmarcQuarantine") return finding;
        const to = finding.code === "dmarcNone" ? "quarantine" : "reject";
        if (readiness.kind === "ready")
            return {
                ...finding,
                severity: "medium",
                params: { ...finding.params, state: "ready", to }
            };
        return {
            ...finding,
            severity: "info",
            params: {
                ...finding.params,
                state: readiness.kind,
                to,
                days: readiness.kind === "collecting" ? readiness.days : 0,
                left: readiness.kind === "collecting" ? READY_DAYS - readiness.days : READY_DAYS
            },
            // The stricter record is not the fix yet, so it is not shown as one.
            records: []
        };
    });
    if (readiness.kind === "failing") {
        for (const sender of readiness.senders.slice(0, MAX_SENDER_FINDINGS)) {
            findings.push({
                code: "dmarcSenderFailing",
                section: "email",
                severity: "medium",
                params: {
                    name: sender.sourceIp,
                    host: sender.hostname ?? sender.sourceIp,
                    failed: sender.failed,
                    signedBy:
                        [...new Set([...sender.dkimDomains, ...sender.spfDomains])].join(", ") ||
                        "-"
                },
                records: [],
                where: null
            });
        }
    }
    return { ...report, findings, grade: gradeOf(findings) };
}
