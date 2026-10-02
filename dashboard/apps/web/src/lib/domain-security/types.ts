/**
 * The shapes of a domain security audit, shared by the checks, the store and the
 * screen. Pure and client-safe: nothing here reaches the network or the database.
 *
 * An audit is a list of findings, each one check's verdict on one domain. A
 * finding names its check by `code`; the words a reader sees for it (what it is,
 * what the risk is, what to do) live in the `domainSecurity` catalog under that
 * code, so the server stores codes and parameters and never a sentence in one
 * language.
 */

export const SECURITY_SECTIONS = ["email", "dns", "registration", "web"] as const;
export type SecuritySection = (typeof SECURITY_SECTIONS)[number];

/** Worst last. `pass` is a check that found nothing wrong, kept so the screen can
 *  say what was checked and not only what failed. */
export const SEVERITIES = ["pass", "info", "low", "medium", "high", "critical"] as const;
export type Severity = (typeof SEVERITIES)[number];

export function severityRank(severity: Severity): number {
    return SEVERITIES.indexOf(severity);
}

/** Every check, by the code its words are filed under. */
export const FINDING_CODES = [
    // Email
    "mxOk",
    "mxNull",
    "mxMissing",
    "spfOk",
    "spfMissing",
    "spfMultiple",
    "spfSyntax",
    "spfAllPass",
    "spfAllNeutral",
    "spfAllSoft",
    "spfAllMissing",
    "spfLookups",
    "spfVoid",
    "spfIncludeMissing",
    "spfPtr",
    "spfUnchecked",
    "dkimOk",
    "dkimNone",
    "dkimWeak",
    "dkimShort",
    "dkimTesting",
    "dmarcOk",
    "dmarcMissing",
    "dmarcMultiple",
    "dmarcSyntax",
    "dmarcNone",
    "dmarcQuarantine",
    "dmarcPct",
    "dmarcSubdomainWeaker",
    "dmarcRuaMissing",
    "dmarcRuaUnauthorized",
    "parkedOk",
    "parkedNullMx",
    "parkedDkim",
    "mtaStsOk",
    "mtaStsMissing",
    "mtaStsPolicy",
    "mtaStsTesting",
    "mtaStsMxMismatch",
    "tlsRptOk",
    "tlsRptMissing",
    "bimiOk",
    "bimiIneligible",
    // DNS
    "dnssecOk",
    "dnssecOff",
    "dnssecNoDs",
    "dnssecBroken",
    "caaOk",
    "caaMissing",
    "caaBlocksPolaris",
    "nsOk",
    "nsSingle",
    "nsSameNetwork",
    "axfrRefused",
    "axfrOpen",
    "danglingOk",
    "danglingCname",
    "wildcard",
    // Registration
    "rdapUnavailable",
    "expiryOk",
    "expirySoon",
    "transferLocked",
    "transferUnlocked",
    "registrantPrivate",
    "registrantPublic",
    // Web
    "webNone",
    "httpsUnreachable",
    "certOk",
    "certInvalid",
    "certExpiring",
    "tlsOk",
    "tlsLegacy",
    "httpRedirectMissing",
    "hstsOk",
    "hstsMissing",
    "hstsShort",
    "headersOk",
    "headerFramingMissing",
    "headerNosniffMissing",
    "headerReferrerMissing",
    "headerCspMissing",
    "securityTxtOk",
    "securityTxtMissing",
    "securityTxtExpired"
] as const;
export type FindingCode = (typeof FINDING_CODES)[number];

/** A record somebody publishes to fix a finding, exactly as it is typed into a
 *  DNS host's form. `DS` is the one only a registrar takes. */
export interface FixRecord {
    readonly type: "TXT" | "MX" | "CAA" | "DS";
    /** The full name, no final dot. */
    readonly name: string;
    readonly value: string;
    readonly priority?: number | null;
}

/**
 * Where a finding is fixed:
 * - `dns`: records in the domain's zone - Polaris writes them when it manages it.
 * - `dnssec`: signing, switched on at the DNS host (Cloudflare through its API).
 * - `registrar`: only the registrar can (a DS record, a transfer lock, a renewal).
 * - `edge`: response headers on a site Polaris serves - Polaris sets them.
 * - `site`: the site's own server, which is not Polaris.
 */
export type FixWhere = "dns" | "dnssec" | "registrar" | "edge" | "site";

export type FindingParams = Readonly<Record<string, string | number>>;

export interface Finding {
    readonly code: FindingCode;
    readonly section: SecuritySection;
    readonly severity: Severity;
    readonly params: FindingParams;
    /** The records that fix it, when the fix is records. */
    readonly records: readonly FixRecord[];
    readonly where: FixWhere | null;
}

/** One word for the whole domain, worst finding first. */
export type Grade = "protected" | "fair" | "weak" | "exposed" | "unknown";

export function gradeOf(findings: readonly Finding[]): Grade {
    if (findings.length === 0) return "unknown";
    const worst = Math.max(...findings.map((finding) => severityRank(finding.severity)));
    if (worst >= severityRank("high")) return "exposed";
    if (worst >= severityRank("medium")) return "weak";
    if (worst >= severityRank("low")) return "fair";
    return "protected";
}

/** A finding's identity across two audits: the same check about the same thing. */
export function findingKey(finding: Pick<Finding, "code" | "params">): string {
    const subject = finding.params.selector ?? finding.params.name ?? finding.params.server ?? finding.params.target ?? "";
    return `${finding.code}:${String(subject)}`;
}

/**
 * The findings of `current` that are new and at least medium, or worse than they
 * were in `previous`. What a daily re-check tells somebody about: a regression,
 * never the same complaint twice.
 */
export function regressions(previous: readonly Finding[] | null, current: readonly Finding[]): Finding[] {
    const before = new Map((previous ?? []).map((finding) => [findingKey(finding), severityRank(finding.severity)]));
    return current.filter((finding) => {
        const rank = severityRank(finding.severity);
        if (rank < severityRank("medium")) return false;
        const had = before.get(findingKey(finding));
        return had === undefined || had < rank;
    });
}

export interface SecurityReport {
    readonly domain: string;
    readonly checkedAt: string;
    readonly grade: Grade;
    /** Whether the domain authorizes anybody to send mail as it. */
    readonly sends: boolean;
    /** Whether it has servers that take mail. */
    readonly receives: boolean;
    /** Where its DMARC aggregate reports go, as the addresses its record names. */
    readonly rua: readonly string[];
    readonly findings: readonly Finding[];
}
