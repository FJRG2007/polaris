/**
 * DMARC aggregate reports (RFC 7489, appendix C), read into something a screen
 * can answer "who is sending as my domain, and does it pass?" from.
 *
 * Every large receiver sends one of these a day to the address in a domain's
 * `rua`. The XML itself is parsed by the caller (it arrives gzipped, zipped or
 * bare, inside a mail); what comes here is the parsed document, which is
 * checked field by field rather than trusted - a report is mail from anybody.
 *
 * What a row counts as passing is DMARC's own rule, taken from the receiver's
 * `policy_evaluated`: aligned DKIM or aligned SPF. The raw `auth_results` are
 * kept for the detail view, because "SPF passed for the wrong domain" is the most
 * common thing an operator needs to see and the verdict alone hides it.
 */

export type DmarcResult =
    | "pass"
    | "fail"
    | "none"
    | "neutral"
    | "softfail"
    | "temperror"
    | "permerror"
    | "policy";

export interface DmarcRow {
    readonly sourceIp: string;
    readonly count: number;
    readonly disposition: "none" | "quarantine" | "reject";
    /** The receiver's verdict on alignment, the one DMARC decides on. */
    readonly dkim: "pass" | "fail";
    readonly spf: "pass" | "fail";
    readonly headerFrom: string;
    readonly authDkim: readonly { domain: string; result: string; selector: string }[];
    readonly authSpf: readonly { domain: string; result: string }[];
}

export interface DmarcReport {
    readonly orgName: string;
    readonly reportId: string;
    readonly email: string;
    readonly begin: Date;
    readonly end: Date;
    readonly domain: string;
    readonly policy: { readonly p: string; readonly sp: string; readonly pct: number };
    readonly rows: readonly DmarcRow[];
}

/** The most rows one report is read for. A real report from even the largest
 *  receiver is a few hundred; past this it is somebody testing a parser. */
export const MAX_DMARC_ROWS = 5000;

function text(value: unknown): string {
    if (typeof value === "string") return value.trim();
    if (typeof value === "number") return String(value);
    if (value && typeof value === "object" && "#text" in value)
        return text((value as { "#text": unknown })["#text"]);
    return "";
}

function number(value: unknown): number {
    const parsed = Number(text(value));
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

/** An element the parser gave as one object or as a list, always as a list. */
function many(value: unknown): unknown[] {
    if (value === undefined || value === null) return [];
    return Array.isArray(value) ? value : [value];
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
}

function verdict(value: unknown): "pass" | "fail" {
    return text(value).toLowerCase() === "pass" ? "pass" : "fail";
}

function disposition(value: unknown): DmarcRow["disposition"] {
    const said = text(value).toLowerCase();
    return said === "quarantine" || said === "reject" ? said : "none";
}

/** A source address as it was written: an IPv4 or IPv6 literal, nothing else. */
function address(value: unknown): string {
    const said = text(value);
    return /^[0-9a-fA-F:.]{2,45}$/.test(said) ? said : "";
}

/** Why a document is not a report, as a sentence. */
export class DmarcReportError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "DmarcReportError";
    }
}

/**
 * Read a parsed aggregate report.
 *
 * `document` is what an XML parser produced for the whole file: an object whose
 * `feedback` element holds `report_metadata`, `policy_published` and one or more
 * `record`s. Anything missing that a report cannot be without is refused; a row
 * with an address that is not an address is dropped rather than shown.
 */
export function normalizeDmarcReport(document: unknown): DmarcReport {
    const feedback = record(record(document).feedback);
    const metadata = record(feedback.report_metadata);
    const published = record(feedback.policy_published);
    const range = record(metadata.date_range);

    const orgName = text(metadata.org_name);
    const reportId = text(metadata.report_id);
    const domain = text(published.domain).toLowerCase();
    const begin = number(range.begin);
    const end = number(range.end);
    if (!orgName || !reportId || !domain || !begin || !end) {
        throw new DmarcReportError("That is not a DMARC aggregate report.");
    }

    const rows: DmarcRow[] = [];
    for (const entry of many(feedback.record).slice(0, MAX_DMARC_ROWS)) {
        const row = record(entry);
        const detail = record(row.row);
        const evaluated = record(detail.policy_evaluated);
        const sourceIp = address(detail.source_ip);
        if (!sourceIp) continue;
        const results = record(row.auth_results);
        rows.push({
            sourceIp,
            count: number(detail.count),
            disposition: disposition(evaluated.disposition),
            dkim: verdict(evaluated.dkim),
            spf: verdict(evaluated.spf),
            headerFrom: text(record(row.identifiers).header_from).toLowerCase(),
            authDkim: many(results.dkim).map((item) => ({
                domain: text(record(item).domain).toLowerCase(),
                result: text(record(item).result).toLowerCase(),
                selector: text(record(item).selector)
            })),
            authSpf: many(results.spf).map((item) => ({
                domain: text(record(item).domain).toLowerCase(),
                result: text(record(item).result).toLowerCase()
            }))
        });
    }

    return {
        orgName,
        reportId,
        email: text(metadata.email).toLowerCase(),
        begin: new Date(begin * 1000),
        end: new Date(end * 1000),
        domain,
        policy: {
            p: text(published.p).toLowerCase() || "none",
            sp: text(published.sp).toLowerCase(),
            pct: published.pct === undefined ? 100 : number(published.pct)
        },
        rows
    };
}

/** Whether a row passed DMARC: aligned DKIM or aligned SPF, as the receiver saw it. */
export function rowPasses(row: DmarcRow): boolean {
    return row.dkim === "pass" || row.spf === "pass";
}

export interface DmarcSource {
    readonly sourceIp: string;
    readonly messages: number;
    readonly passed: number;
    readonly failed: number;
    /** Who reported mail from this address. */
    readonly reporters: readonly string[];
    readonly verdict: "pass" | "warn" | "fail";
}

/**
 * Every address that sent as the domain, across a set of reports, worst first.
 *
 * An address whose mail all passed is a sender that is set up; one whose mail all
 * failed is either somebody spoofing the domain or a real sender nobody added to
 * SPF and DKIM - the screen says which question to ask, not which answer is true.
 */
export function summarizeDmarcSources(reports: readonly DmarcReport[]): DmarcSource[] {
    const bySource = new Map<
        string,
        { messages: number; passed: number; reporters: Set<string> }
    >();
    for (const report of reports) {
        for (const row of report.rows) {
            const entry = bySource.get(row.sourceIp) ?? {
                messages: 0,
                passed: 0,
                reporters: new Set<string>()
            };
            entry.messages += row.count;
            if (rowPasses(row)) entry.passed += row.count;
            entry.reporters.add(report.orgName);
            bySource.set(row.sourceIp, entry);
        }
    }
    const rank = { fail: 0, warn: 1, pass: 2 } as const;
    return [...bySource.entries()]
        .map(([sourceIp, entry]) => {
            const failed = entry.messages - entry.passed;
            const verdict: DmarcSource["verdict"] =
                failed === 0 ? "pass" : entry.passed === 0 ? "fail" : "warn";
            return {
                sourceIp,
                messages: entry.messages,
                passed: entry.passed,
                failed,
                reporters: [...entry.reporters].sort(),
                verdict
            };
        })
        .sort(
            (left, right) =>
                rank[left.verdict] - rank[right.verdict] || right.messages - left.messages
        );
}
