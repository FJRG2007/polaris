/**
 * Turning an audit into the changes Polaris would make, before it makes any.
 *
 * Pure: the report and the zone's records as they are now go in, a list of
 * changes comes out, each with what is there before and what would be there
 * after - the preview a person approves. The rules it keeps:
 *
 * - One SPF, ever. A missing piece is merged into the record that exists; two
 *   records become one, the others removed and shown as removed.
 * - Nothing published is replaced silently: an update always carries the value
 *   it replaces.
 * - DMARC starts at `p=none` for a domain that sends mail (with reports to
 *   Polaris when it reads them), and only moves to quarantine or reject when the
 *   person asks for that policy. A domain that sends no mail is locked down at
 *   reject from the start, which is what locking it down means.
 * - CAA is added to, never rewritten: a second issuer record allows Polaris's CA
 *   alongside whatever was allowed.
 */

import { POLARIS_CA } from "./evaluate";
import { txtText } from "@/lib/dns/record-schema";
import type { FindingCode, SecurityReport } from "./types";
import { isDmarc, isSpf, mergeSpfRecords, parseDmarc, withPolicy, withRua, type DmarcPolicy } from "./records";

export type ChangeAction = "create" | "update" | "delete";

export interface PlannedChange {
    /** Stable for one plan of one zone: what the person approves by. */
    readonly id: string;
    readonly kind: "record" | "dnssec" | "edge";
    readonly action: ChangeAction;
    readonly type: "TXT" | "MX" | "CAA" | null;
    /** The record's full name, the hostname for an edge change, the zone for DNSSEC. */
    readonly name: string;
    readonly before: readonly string[];
    readonly after: string | null;
    /** The record replaced or removed. */
    readonly recordId: string | null;
    /** The check it answers. */
    readonly code: FindingCode;
    /** A service whose edge headers change. */
    readonly applicationId: string | null;
}

/** A zone record as the planner reads it. */
export interface ZoneRecordLike {
    readonly id: string;
    readonly type: string;
    readonly name: string;
    readonly content: string;
    readonly priority?: number | null;
}

/** A service answering on one of the domain's names, and its header preset. */
export interface EdgeTarget {
    readonly applicationId: string;
    readonly hostname: string;
    readonly preset: "off" | "recommended" | "strict";
}

export interface PlanInput {
    readonly report: SecurityReport;
    /** null when Polaris cannot read the zone, so nothing is planned in it. */
    readonly records: readonly ZoneRecordLike[] | null;
    /** Whether Polaris can switch DNSSEC on for the zone. */
    readonly canSign: boolean;
    readonly edge: readonly EdgeTarget[];
    /** Where Polaris reads DMARC reports for this domain, when it does. */
    readonly reportAddress: string | null;
    /** A stricter DMARC policy the person chose, or null to leave the policy be. */
    readonly dmarcPolicy: Exclude<DmarcPolicy, "none"> | null;
}

function same(name: string, other: string): boolean {
    return name.toLowerCase().replace(/\.$/, "") === other.toLowerCase().replace(/\.$/, "");
}

/** A change's id: what it does and where, so approving it twice is one change. */
function idOf(kind: string, action: string, type: string | null, name: string, extra = ""): string {
    return [kind, action, type ?? "", name.toLowerCase(), extra].join("|");
}

export function planChanges(input: PlanInput): PlannedChange[] {
    const { report, records } = input;
    const domain = report.domain;
    const codes = new Set(report.findings.map((finding) => finding.code));
    const changes: PlannedChange[] = [];
    const push = (change: Omit<PlannedChange, "id">, extra = "") =>
        changes.push({ ...change, id: idOf(change.kind, change.action, change.type, change.name, extra) });

    if (records) {
        const at = (type: string, name: string) => records.filter((record) => record.type === type && same(record.name, name));
        const apexTxt = at("TXT", domain).map((record) => ({ ...record, text: txtText(record.content) }));
        const spfs = apexTxt.filter((record) => isSpf(record.text));
        const parked = !report.sends && !report.receives;

        // --- SPF ---
        const spfFinding = report.findings.find((finding) => finding.code === "spfMissing");
        if (spfs.length === 0 && spfFinding) {
            const value = spfFinding.records[0]?.value ?? (parked ? "v=spf1 -all" : "v=spf1 mx ~all");
            push({ kind: "record", action: "create", type: "TXT", name: domain, before: [], after: value, recordId: null, code: "spfMissing", applicationId: null });
        } else if (spfs.length > 1) {
            const merged = spfs.slice(1).reduce((value, record) => mergeSpfRecords(value, record.text), spfs[0]!.text);
            push({ kind: "record", action: "update", type: "TXT", name: domain, before: [spfs[0]!.text], after: merged, recordId: spfs[0]!.id, code: "spfMultiple", applicationId: null });
            for (const extra of spfs.slice(1)) {
                push({ kind: "record", action: "delete", type: "TXT", name: domain, before: [extra.text], after: null, recordId: extra.id, code: "spfMultiple", applicationId: null }, extra.id);
            }
        } else if (spfs.length === 1 && (codes.has("spfAllPass") || codes.has("spfAllNeutral") || codes.has("spfAllMissing"))) {
            const current = spfs[0]!.text;
            const ending = parked ? "-all" : "~all";
            const next = [...current.trim().split(/\s+/).filter((part) => !/^[+\-~?]?all$/i.test(part)), ending].join(" ");
            const code: FindingCode = codes.has("spfAllPass") ? "spfAllPass" : codes.has("spfAllNeutral") ? "spfAllNeutral" : "spfAllMissing";
            push({ kind: "record", action: "update", type: "TXT", name: domain, before: [current], after: next, recordId: spfs[0]!.id, code, applicationId: null });
        }

        // --- DMARC ---
        const dmarcName = `_dmarc.${domain}`;
        const dmarcs = at("TXT", dmarcName)
            .map((record) => ({ ...record, text: txtText(record.content) }))
            .filter((record) => isDmarc(record.text));
        const dmarcFinding = report.findings.find((finding) => finding.code === "dmarcMissing");
        if (dmarcs.length === 0 && dmarcFinding?.records[0]) {
            push({ kind: "record", action: "create", type: "TXT", name: dmarcName, before: [], after: dmarcFinding.records[0].value, recordId: null, code: "dmarcMissing", applicationId: null });
        } else if (dmarcs.length === 1) {
            const current = dmarcs[0]!.text;
            const parsed = parseDmarc(current);
            let next = current;
            let code: FindingCode | null = null;
            if (parsed.ok && input.dmarcPolicy) {
                const order = ["none", "quarantine", "reject"];
                if (order.indexOf(input.dmarcPolicy) > order.indexOf(parsed.record.p)) {
                    next = withPolicy(next, input.dmarcPolicy);
                    code = parsed.record.p === "none" ? "dmarcNone" : "dmarcQuarantine";
                }
            }
            if (parsed.ok && parsed.record.rua.length === 0 && input.reportAddress) {
                next = withRua(next, `mailto:${input.reportAddress}`);
                code ??= "dmarcRuaMissing";
            }
            if (code && next !== current) {
                push({ kind: "record", action: "update", type: "TXT", name: dmarcName, before: [current], after: next, recordId: dmarcs[0]!.id, code, applicationId: null });
            }
        }

        // --- A domain that takes no mail says so ---
        if ((codes.has("parkedNullMx") || codes.has("mxMissing")) && at("MX", domain).length === 0) {
            push({ kind: "record", action: "create", type: "MX", name: domain, before: [], after: ".", recordId: null, code: codes.has("parkedNullMx") ? "parkedNullMx" : "mxMissing", applicationId: null });
        }
        const dkimName = `*._domainkey.${domain}`;
        if (codes.has("parkedDkim") && at("TXT", dkimName).length === 0) {
            push({ kind: "record", action: "create", type: "TXT", name: dkimName, before: [], after: "v=DKIM1; p=", recordId: null, code: "parkedDkim", applicationId: null });
        }

        // --- TLS reports ---
        const rpt = report.findings.find((finding) => finding.code === "tlsRptMissing")?.records[0];
        const rptName = `_smtp._tls.${domain}`;
        if (rpt && at("TXT", rptName).length === 0) {
            push({ kind: "record", action: "create", type: "TXT", name: rptName, before: [], after: rpt.value, recordId: null, code: "tlsRptMissing", applicationId: null });
        }

        // --- CAA: allow Polaris's CA ---
        const caaCode: FindingCode | null = codes.has("caaBlocksPolaris") ? "caaBlocksPolaris" : codes.has("caaMissing") && report.findings.some((finding) => finding.code === "caaMissing" && finding.records.length > 0) ? "caaMissing" : null;
        if (caaCode) {
            const current = at("CAA", domain).map((record) => record.content);
            if (!current.some((value) => value.toLowerCase().includes(POLARIS_CA))) {
                push({ kind: "record", action: "create", type: "CAA", name: domain, before: current, after: `0 issue "${POLARIS_CA}"`, recordId: null, code: caaCode, applicationId: null });
            }
        }
    }

    // --- DNSSEC, switched on at the DNS host ---
    if (input.canSign && codes.has("dnssecOff")) {
        push({ kind: "dnssec", action: "create", type: null, name: domain, before: [], after: null, recordId: null, code: "dnssecOff", applicationId: null });
    }

    // --- Security headers on a site Polaris serves ---
    const headerCodes: FindingCode[] = ["hstsMissing", "hstsShort", "headerFramingMissing", "headerNosniffMissing", "headerReferrerMissing"];
    const headerCode = headerCodes.find((code) => report.findings.some((finding) => finding.code === code && finding.where === "edge"));
    if (headerCode) {
        for (const target of input.edge.filter((entry) => entry.preset === "off")) {
            push(
                { kind: "edge", action: "update", type: null, name: target.hostname, before: ["off"], after: "recommended", recordId: null, code: headerCode, applicationId: target.applicationId },
                target.applicationId
            );
        }
    }
    return changes;
}

/** The changes a domain handed to Polaris gets without asking: every one the
 *  plan makes on its own. A stricter DMARC policy is never in it, since the plan
 *  only makes that when somebody chose it. */
export function automaticChanges(changes: readonly PlannedChange[]): PlannedChange[] {
    return changes.filter((change) => change.kind !== "edge");
}

/** A change written the way a preview and an approval both carry it, so an
 *  approval of a plan that has since changed is refused rather than applied. */
export function fingerprint(change: PlannedChange): string {
    return `${change.id}#${change.before.join("\u0001")}#${change.after ?? ""}`;
}
