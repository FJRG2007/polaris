/**
 * Judging a domain from what was collected about it. Pure: facts in, findings
 * out, with the clock passed in so expiry is tested at a fixed moment.
 *
 * The advice follows what the domain is for. A domain that sends no mail and
 * takes none is locked down (an SPF that allows nobody, a DMARC that rejects, a
 * null MX) - Cloudflare's "protect domains that do not send email" - while one
 * that sends is walked towards DMARC enforcement one step at a time, never
 * straight to reject, since that is how real mail gets lost.
 */

import type { DomainFacts } from "./facts";
import * as rec from "./records";
import {
    gradeOf,
    type Finding,
    type FindingCode,
    type FindingParams,
    type FixRecord,
    type FixWhere,
    type SecurityReport,
    type SecuritySection,
    type Severity
} from "./types";

const DAY = 24 * 60 * 60 * 1000;

/** The CA Polaris orders its certificates from. */
export const POLARIS_CA = "letsencrypt.org";

/** HSTS shorter than this is not counted as protection (half a year). */
const HSTS_MIN = 15_552_000;

/** The DKIM selectors every audit tries: Polaris's own engine's, then the common
 *  providers' (Google, Microsoft 365, IONOS, Zoho, Mailchimp, SendGrid, Amazon
 *  SES via CNAME, Postmark, Resend, Fastmail, Proton). */
export const COMMON_DKIM_SELECTORS = [
    "default",
    "google",
    "selector1",
    "selector2",
    "s1",
    "s2",
    "k1",
    "k2",
    "dkim",
    "mail",
    "zoho",
    "zmail",
    "mandrill",
    "smtpapi",
    "resend",
    "fm1",
    "fm2",
    "fm3",
    "protonmail",
    "protonmail2",
    "protonmail3"
] as const;

class Findings {
    readonly list: Finding[] = [];

    add(
        section: SecuritySection,
        code: FindingCode,
        severity: Severity,
        params: FindingParams = {},
        fix: { records?: readonly FixRecord[]; where?: FixWhere | null } = {}
    ): void {
        this.list.push({
            section,
            code,
            severity,
            params,
            records: fix.records ?? [],
            where: fix.where ?? null
        });
    }
}

function txt(name: string, value: string): FixRecord {
    return { type: "TXT", name, value };
}

/** The lockdown a domain that sends no mail publishes. */
export function lockdownRecords(domain: string, reportAddress: string | null): FixRecord[] {
    return [
        txt(domain, "v=spf1 -all"),
        txt(
            `_dmarc.${domain}`,
            rec.formatDmarc({
                p: "reject",
                sp: "reject",
                adkim: "s",
                aspf: "s",
                rua: reportAddress ? [`mailto:${reportAddress}`] : []
            })
        ),
        { type: "MX", name: domain, value: ".", priority: 0 },
        txt(`*._domainkey.${domain}`, "v=DKIM1; p=")
    ];
}

function emailFindings(
    facts: DomainFacts,
    out: Findings
): { sends: boolean; receives: boolean; rua: string[] } {
    const domain = facts.domain;
    const mx = facts.mx;
    const nullMx =
        mx !== null && mx.length === 1 && (mx[0]!.exchange === "" || mx[0]!.exchange === ".");
    const receives = mx !== null && mx.length > 0 && !nullMx;

    const spfTexts = facts.apexTxt?.filter(rec.isSpf) ?? null;
    const spf = spfTexts && spfTexts.length === 1 ? rec.parseSpf(spfTexts[0]!) : null;
    const dkim = facts.dkim ?? [];
    const liveDkim = dkim.filter((entry) => (rec.parseDkim(entry.text)?.publicKey ?? "") !== "");
    const sends =
        (spf?.ok === true && rec.spfAuthorizesSenders(spf)) ||
        liveDkim.length > 0 ||
        facts.context.mailServerSpf !== null;
    const parked = !sends && !receives;
    const report = facts.context.reportAddress;

    // --- MX ---
    if (mx !== null) {
        if (nullMx) out.add("email", "mxNull", "pass");
        else if (receives)
            out.add("email", "mxOk", "pass", {
                count: mx.length,
                hosts: mx.map((host) => host.exchange).join(", ")
            });
        else if (sends)
            out.add(
                "email",
                "mxMissing",
                "low",
                {},
                { records: [{ type: "MX", name: domain, value: ".", priority: 0 }], where: "dns" }
            );
        else
            out.add(
                "email",
                "parkedNullMx",
                "low",
                {},
                { records: [{ type: "MX", name: domain, value: ".", priority: 0 }], where: "dns" }
            );
    }

    // --- SPF ---
    if (spfTexts === null) {
        out.add("email", "spfUnchecked", "info");
    } else if (spfTexts.length === 0) {
        const value = parked
            ? "v=spf1 -all"
            : (facts.context.mailServerSpf ?? (receives ? "v=spf1 mx ~all" : "v=spf1 -all"));
        out.add(
            "email",
            "spfMissing",
            "high",
            { parked: parked ? "yes" : "no" },
            { records: [txt(domain, value)], where: "dns" }
        );
    } else if (spfTexts.length > 1) {
        out.add("email", "spfMultiple", "critical", { count: spfTexts.length }, { where: "dns" });
    } else if (spf && !spf.ok) {
        out.add("email", "spfSyntax", "high", { term: spf.bad.slice(0, 80) }, { where: "dns" });
    } else if (spf && spf.ok) {
        const all = spf.all;
        const walk = facts.spfWalk;
        let clean = true;
        if (all === "+") {
            clean = false;
            out.add("email", "spfAllPass", "critical", {}, { where: "dns" });
        } else if (all === "?") {
            clean = false;
            out.add("email", "spfAllNeutral", "high", {}, { where: "dns" });
        } else if (all === null && spf.redirect === null) {
            clean = false;
            out.add("email", "spfAllMissing", "medium", {}, { where: "dns" });
        } else if (all === "~") {
            out.add("email", "spfAllSoft", "low", {}, { where: "dns" });
        }
        if (walk) {
            if (walk.lookups > 10) {
                clean = false;
                out.add(
                    "email",
                    "spfLookups",
                    "critical",
                    { count: walk.lookups },
                    { where: "dns" }
                );
            }
            if (walk.voids > 2) {
                clean = false;
                out.add("email", "spfVoid", "high", { count: walk.voids }, { where: "dns" });
            }
            for (const target of [...walk.missing, ...walk.broken]) {
                clean = false;
                out.add("email", "spfIncludeMissing", "high", { target }, { where: "dns" });
            }
        }
        if (spf.terms.some((term) => term.mechanism === "ptr"))
            out.add("email", "spfPtr", "low", {}, { where: "dns" });
        if (clean)
            out.add("email", "spfOk", "pass", {
                all: all ? `${all}all` : "redirect",
                lookups: walk?.lookups ?? 0
            });
    }

    // --- DKIM ---
    if (facts.dkim !== null) {
        for (const entry of dkim) {
            const key = rec.parseDkim(entry.text);
            if (!key || key.publicKey === "") continue;
            if (key.keyType === "rsa" && entry.bits !== null && entry.bits < 1024) {
                out.add(
                    "email",
                    "dkimWeak",
                    "high",
                    { selector: entry.selector, bits: entry.bits },
                    { where: "site" }
                );
            } else if (key.keyType === "rsa" && entry.bits !== null && entry.bits < 2048) {
                out.add(
                    "email",
                    "dkimShort",
                    "low",
                    { selector: entry.selector, bits: entry.bits },
                    { where: "site" }
                );
            }
            if (key.testing)
                out.add(
                    "email",
                    "dkimTesting",
                    "low",
                    { selector: entry.selector },
                    { where: "site" }
                );
        }
        if (liveDkim.length > 0) {
            out.add("email", "dkimOk", "pass", {
                selectors: liveDkim.map((entry) => entry.selector).join(", ")
            });
        } else if (sends) {
            out.add(
                "email",
                "dkimNone",
                "low",
                { selectors: facts.dkimSelectorsTried.slice(0, 8).join(", ") },
                { where: "site" }
            );
        } else if (parked && !dkim.some((entry) => entry.selector === "*")) {
            out.add(
                "email",
                "parkedDkim",
                "info",
                {},
                { records: [txt(`*._domainkey.${domain}`, "v=DKIM1; p=")], where: "dns" }
            );
        }
    }

    // --- DMARC ---
    const rua: string[] = [];
    const dmarcTexts = facts.dmarcTxt?.filter(rec.isDmarc) ?? null;
    let enforcing = false;
    if (dmarcTexts !== null) {
        if (dmarcTexts.length === 0) {
            const value = parked
                ? rec.formatDmarc({
                      p: "reject",
                      sp: "reject",
                      adkim: "s",
                      aspf: "s",
                      rua: report ? [`mailto:${report}`] : []
                  })
                : rec.formatDmarc({ p: "none", rua: report ? [`mailto:${report}`] : [] });
            out.add(
                "email",
                "dmarcMissing",
                "high",
                { parked: parked ? "yes" : "no" },
                { records: [txt(`_dmarc.${domain}`, value)], where: "dns" }
            );
        } else if (dmarcTexts.length > 1) {
            out.add(
                "email",
                "dmarcMultiple",
                "critical",
                { count: dmarcTexts.length },
                { where: "dns" }
            );
        } else {
            const parsed = rec.parseDmarc(dmarcTexts[0]!);
            if (!parsed.ok) {
                out.add(
                    "email",
                    "dmarcSyntax",
                    "high",
                    { term: parsed.bad.slice(0, 80) },
                    { where: "dns" }
                );
            } else {
                const record = parsed.record;
                rua.push(...record.rua);
                const dmarcName = `_dmarc.${domain}`;
                let clean = true;
                if (record.p === "none") {
                    clean = false;
                    out.add(
                        "email",
                        "dmarcNone",
                        "medium",
                        {},
                        {
                            records: [txt(dmarcName, rec.withPolicy(dmarcTexts[0]!, "quarantine"))],
                            where: "dns"
                        }
                    );
                } else if (record.p === "quarantine") {
                    out.add(
                        "email",
                        "dmarcQuarantine",
                        "low",
                        {},
                        {
                            records: [txt(dmarcName, rec.withPolicy(dmarcTexts[0]!, "reject"))],
                            where: "dns"
                        }
                    );
                }
                if (record.p !== "none" && record.pct < 100) {
                    clean = false;
                    out.add("email", "dmarcPct", "medium", { pct: record.pct }, { where: "dns" });
                }
                const order = ["none", "quarantine", "reject"];
                if (record.spSet && order.indexOf(record.sp) < order.indexOf(record.p)) {
                    clean = false;
                    out.add(
                        "email",
                        "dmarcSubdomainWeaker",
                        "medium",
                        { sp: record.sp, p: record.p },
                        { where: "dns" }
                    );
                }
                if (record.rua.length === 0) {
                    out.add("email", "dmarcRuaMissing", "low", {}, { where: "dns" });
                }
                for (const [host, authorized] of Object.entries(facts.ruaAuthorization)) {
                    if (authorized === false)
                        out.add("email", "dmarcRuaUnauthorized", "low", { host }, { where: "dns" });
                }
                enforcing = record.p !== "none" && record.pct === 100;
                if (clean) out.add("email", "dmarcOk", "pass", { policy: record.p, sp: record.sp });
            }
        }
    }

    if (parked && spf?.ok === true && spf.all === "-" && enforcing && nullMx)
        out.add("email", "parkedOk", "pass");

    // --- MTA-STS and TLS-RPT: only for a domain that takes mail ---
    if (receives) {
        const stsTexts =
            facts.mtaStsTxt?.filter((text) => /^v=STSv1\s*;/i.test(text.trim())) ?? null;
        if (stsTexts !== null) {
            if (stsTexts.length === 0) {
                out.add("email", "mtaStsMissing", "low", {}, { where: "site" });
            } else {
                const fetched = facts.mtaStsPolicy;
                const policy =
                    fetched?.status === "ok" ? rec.parseMtaStsPolicy(fetched.text) : null;
                if (fetched && fetched.status !== "unreachable" && !policy) {
                    out.add(
                        "email",
                        "mtaStsPolicy",
                        "medium",
                        { host: `mta-sts.${domain}` },
                        { where: "site" }
                    );
                } else if (policy) {
                    const uncovered = (mx ?? []).filter(
                        (host) => !rec.mxCovered(host.exchange, policy.mx)
                    );
                    if (policy.mode === "enforce" && uncovered.length > 0) {
                        out.add(
                            "email",
                            "mtaStsMxMismatch",
                            "high",
                            { hosts: uncovered.map((host) => host.exchange).join(", ") },
                            { where: "site" }
                        );
                    } else if (policy.mode !== "enforce") {
                        out.add(
                            "email",
                            "mtaStsTesting",
                            "low",
                            { mode: policy.mode },
                            { where: "site" }
                        );
                    } else {
                        out.add("email", "mtaStsOk", "pass");
                    }
                }
            }
        }
        const rpt = facts.tlsRptTxt?.filter((text) => /^v=TLSRPTv1\s*;/i.test(text.trim())) ?? null;
        if (rpt !== null) {
            if (rpt.length === 0) {
                out.add(
                    "email",
                    "tlsRptMissing",
                    "low",
                    {},
                    {
                        records: report
                            ? [txt(`_smtp._tls.${domain}`, `v=TLSRPTv1; rua=mailto:${report}`)]
                            : [],
                        where: "dns"
                    }
                );
            } else {
                out.add("email", "tlsRptOk", "pass");
            }
        }
    }

    const bimi = facts.bimiTxt?.filter((text) => /^v=BIMI1\s*;/i.test(text.trim())) ?? [];
    if (bimi.length > 0) {
        if (enforcing) out.add("email", "bimiOk", "pass");
        else out.add("email", "bimiIneligible", "info");
    }

    return { sends, receives, rua };
}

function dnsFindings(facts: DomainFacts, out: Findings): void {
    const domain = facts.domain;
    const { ds, dnskey, validated } = facts.dnssec;
    if (ds === true && validated === false) {
        out.add("dns", "dnssecBroken", "high", {}, { where: "registrar" });
    } else if (ds === true) {
        out.add("dns", "dnssecOk", "pass");
    } else if (ds === false && dnskey === true) {
        const records: FixRecord[] = facts.context.dsRecord
            ? [{ type: "DS", name: domain, value: facts.context.dsRecord }]
            : [];
        out.add("dns", "dnssecNoDs", "medium", {}, { records, where: "registrar" });
    } else if (ds === false) {
        out.add("dns", "dnssecOff", "low", {}, { where: "dnssec" });
    }

    if (facts.caa !== null) {
        const issuers = facts.caa
            .filter((entry) => entry.tag === "issue" || entry.tag === "issuewild")
            .map((entry) => entry.value.split(";")[0]!.trim().toLowerCase());
        const record: FixRecord = { type: "CAA", name: domain, value: `0 issue "${POLARIS_CA}"` };
        if (facts.caa.length === 0) {
            out.add(
                "dns",
                "caaMissing",
                "low",
                {},
                { records: facts.context.polarisIssues ? [record] : [], where: "dns" }
            );
        } else if (
            facts.context.polarisIssues &&
            issuers.length > 0 &&
            !issuers.includes(POLARIS_CA)
        ) {
            out.add(
                "dns",
                "caaBlocksPolaris",
                "high",
                { issuers: [...new Set(issuers)].join(", ") || ";" },
                { records: [record], where: "dns" }
            );
        } else {
            out.add("dns", "caaOk", "pass", { issuers: [...new Set(issuers)].join(", ") });
        }
    }

    if (facts.ns !== null) {
        const servers = facts.ns;
        const blocks = new Set(
            servers.flatMap((server) =>
                server.addresses
                    .filter((address) => !address.includes(":"))
                    .map((address) => address.split(".").slice(0, 3).join("."))
            )
        );
        if (servers.length < 2)
            out.add("dns", "nsSingle", "medium", { count: servers.length }, { where: "registrar" });
        else if (blocks.size === 1)
            out.add(
                "dns",
                "nsSameNetwork",
                "low",
                { block: `${[...blocks][0]}.0/24` },
                { where: "registrar" }
            );
        else out.add("dns", "nsOk", "pass", { count: servers.length });
    }

    const open = facts.axfr.filter((entry) => entry.open === true);
    for (const entry of open)
        out.add("dns", "axfrOpen", "high", { server: entry.server }, { where: "site" });
    if (
        open.length === 0 &&
        facts.axfr.length > 0 &&
        facts.axfr.every((entry) => entry.open === false)
    ) {
        out.add("dns", "axfrRefused", "pass", { count: facts.axfr.length });
    }

    for (const entry of facts.dangling)
        out.add(
            "dns",
            "danglingCname",
            "high",
            { name: entry.name, target: entry.target },
            { where: "dns" }
        );
    if (facts.dangling.length === 0 && facts.danglingChecked > 0)
        out.add("dns", "danglingOk", "pass", { count: facts.danglingChecked });

    if (facts.wildcard === true)
        out.add("dns", "wildcard", facts.context.polarisZone ? "info" : "low", {
            name: `*.${domain}`
        });
}

function registrationFindings(facts: DomainFacts, now: Date, out: Findings): void {
    const registration = facts.registration;
    if (!registration) {
        out.add("registration", "rdapUnavailable", "info");
        return;
    }
    const registrar = registration.registrar ?? "";
    if (registration.expiresAt) {
        const days = Math.floor((Date.parse(registration.expiresAt) - now.getTime()) / DAY);
        const params = { date: registration.expiresAt.slice(0, 10), days, registrar };
        if (days < 14)
            out.add("registration", "expirySoon", "critical", params, { where: "registrar" });
        else if (days < 30)
            out.add("registration", "expirySoon", "high", params, { where: "registrar" });
        else if (days < 60)
            out.add("registration", "expirySoon", "medium", params, { where: "registrar" });
        else out.add("registration", "expiryOk", "pass", params);
    }
    if (registration.statuses.length > 0) {
        const locked = registration.statuses.some((status) =>
            /(client|server) ?transfer ?prohibited/i.test(status)
        );
        if (locked) out.add("registration", "transferLocked", "pass");
        else
            out.add(
                "registration",
                "transferUnlocked",
                "medium",
                { registrar },
                { where: "registrar" }
            );
    }
    if (registration.registrantRedacted === true)
        out.add("registration", "registrantPrivate", "pass");
    else if (registration.registrantRedacted === false)
        out.add("registration", "registrantPublic", "low", { registrar }, { where: "registrar" });
}

/** A header's value, by its lower-case name. */
function header(headers: Readonly<Record<string, string>>, name: string): string | null {
    return headers[name] ?? null;
}

function webFindings(facts: DomainFacts, now: Date, out: Findings): void {
    const web = facts.web;
    if (!web) {
        out.add("web", "webNone", "info");
        return;
    }
    const where: FixWhere = web.servedByPolaris ? "edge" : "site";
    if (!web.certificate) {
        out.add(
            "web",
            "httpsUnreachable",
            "medium",
            { error: (web.httpsError ?? "").slice(0, 120) },
            { where: "site" }
        );
        return;
    }
    const certificate = web.certificate;
    const daysLeft = Math.floor((Date.parse(certificate.validTo) - now.getTime()) / DAY);
    if (!certificate.trusted) {
        out.add(
            "web",
            "certInvalid",
            "high",
            { reason: (certificate.error ?? "").slice(0, 120), issuer: certificate.issuer },
            { where: web.servedByPolaris ? "edge" : "site" }
        );
    } else if (daysLeft < 14) {
        out.add(
            "web",
            "certExpiring",
            "high",
            { days: daysLeft, date: certificate.validTo.slice(0, 10) },
            { where: "site" }
        );
    } else if (daysLeft < 30) {
        out.add(
            "web",
            "certExpiring",
            "medium",
            { days: daysLeft, date: certificate.validTo.slice(0, 10) },
            { where: "site" }
        );
    } else {
        out.add("web", "certOk", "pass", {
            issuer: certificate.issuer,
            date: certificate.validTo.slice(0, 10)
        });
    }

    if (web.legacyProtocol)
        out.add("web", "tlsLegacy", "medium", { version: web.legacyProtocol }, { where: "site" });
    else if (web.protocol) out.add("web", "tlsOk", "pass", { version: web.protocol });

    if (web.httpRedirects === false) out.add("web", "httpRedirectMissing", "medium", {}, { where });

    const headers = web.headers;
    if (headers) {
        const hsts = header(headers, "strict-transport-security");
        const maxAge = hsts ? Number(/max-age\s*=\s*"?(\d+)/i.exec(hsts)?.[1] ?? 0) : 0;
        if (!hsts || maxAge === 0) out.add("web", "hstsMissing", "medium", {}, { where });
        else if (maxAge < HSTS_MIN) out.add("web", "hstsShort", "low", { maxAge }, { where });
        else {
            const preload =
                /includesubdomains/i.test(hsts) && /preload/i.test(hsts) && maxAge >= 31_536_000;
            out.add("web", "hstsOk", "pass", { maxAge, preload: preload ? "yes" : "no" });
        }
        const csp = header(headers, "content-security-policy") ?? "";
        const framing = header(headers, "x-frame-options") !== null || /frame-ancestors/i.test(csp);
        const missing: string[] = [];
        if (!framing) {
            missing.push("framing");
            out.add("web", "headerFramingMissing", "medium", {}, { where });
        }
        if ((header(headers, "x-content-type-options") ?? "").toLowerCase() !== "nosniff") {
            missing.push("nosniff");
            out.add("web", "headerNosniffMissing", "low", {}, { where });
        }
        if (header(headers, "referrer-policy") === null) {
            missing.push("referrer");
            out.add("web", "headerReferrerMissing", "low", {}, { where });
        }
        if (!csp) {
            missing.push("csp");
            out.add("web", "headerCspMissing", "info", {}, { where: "site" });
        }
        if (missing.length === 0) out.add("web", "headersOk", "pass");
    }

    if (web.securityTxt?.status === "missing") {
        out.add(
            "web",
            "securityTxtMissing",
            "low",
            { url: `https://${facts.domain}/.well-known/security.txt` },
            { where: "site" }
        );
    } else if (web.securityTxt?.status === "ok") {
        const parsed = rec.parseSecurityTxt(web.securityTxt.text);
        if (!parsed)
            out.add(
                "web",
                "securityTxtMissing",
                "low",
                { url: `https://${facts.domain}/.well-known/security.txt` },
                { where: "site" }
            );
        else if (parsed.expires && Date.parse(parsed.expires) < now.getTime()) {
            out.add(
                "web",
                "securityTxtExpired",
                "low",
                { date: parsed.expires.slice(0, 10) },
                { where: "site" }
            );
        } else out.add("web", "securityTxtOk", "pass");
    }
}

/** Every finding about a domain, and the summary the lists show. */
export function evaluate(facts: DomainFacts, now: Date = new Date()): SecurityReport {
    const out = new Findings();
    const mail = emailFindings(facts, out);
    dnsFindings(facts, out);
    registrationFindings(facts, now, out);
    webFindings(facts, now, out);
    return {
        domain: facts.domain,
        checkedAt: now.toISOString(),
        grade: gradeOf(out.list),
        sends: mail.sends,
        receives: mail.receives,
        rua: mail.rua,
        findings: out.list
    };
}

/** The report hosts of a DMARC record that are outside the domain, each of which
 *  has to authorize the reports (RFC 7489 7.1). */
export function externalReportHosts(domain: string, dmarcText: string): string[] {
    const tags = rec.parseTags(dmarcText);
    if (!tags) return [];
    const hosts = (tags.get("rua") ?? "")
        .split(",")
        .map((part) => rec.reportHost(part.trim().replace(/!\d+[kmgt]?$/i, "")))
        .filter((host): host is string => host !== null);
    const base = domain.toLowerCase();
    return [
        ...new Set(
            hosts.filter(
                (host) => host !== base && !host.endsWith(`.${base}`) && !base.endsWith(`.${host}`)
            )
        )
    ];
}
