/**
 * Domain security: auditing every domain Polaris knows, keeping the answer,
 * fixing what Polaris may fix, and telling people when something gets worse.
 *
 * Who sees what:
 * - An administrator sees every known domain and fixes any whose zone the
 *   instance's Cloudflare token reaches.
 * - The owner of a brought domain (a person, or an organization's domain
 *   managers) sees that domain and fixes it with the token they gave it.
 *
 * An audit reads public data only and is stored per domain; screens read the
 * stored one and a re-check is throttled, so opening a page never sets off a
 * round of lookups. A daily pass re-audits everything, a few domains per run,
 * tells the people responsible about anything that got worse, and applies the
 * safe fixes to domains handed to Polaris. Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { evaluate } from "./evaluate";
import { readReport } from "./stored";
import * as zones from "@/lib/dns/zone-records";
import { notify } from "@/lib/notifications/dispatch";
import { collectFacts, type Probes } from "./collect";
import type { DomainOwner } from "@/lib/owner-domains";
import { publicResolver } from "@/lib/dns/public-resolver";
import * as cf from "@/lib/integrations/cloudflare-api";
import { openText } from "@/lib/tls/managed-certificates";
import { orgPeopleHolding } from "@/lib/orgs/org-service";
import { wordsFor } from "@/lib/notifications/notice-words";
import { knownDomain, knownDomains, type KnownDomain } from "./inventory";
import { storedReport } from "@/lib/mail-server/dmarc-report";
import { sendingSources, type SendingSource } from "./dmarc-sources";
import { regressions, type Grade, type SecurityReport } from "./types";
import { emptyDraft, type DnsRecordDraft } from "@/lib/dns/record-schema";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";
import {
    automaticChanges,
    fingerprint,
    planChanges,
    type EdgeTarget,
    type PlannedChange,
    type ZoneRecordLike
} from "./plan";

/** Somebody asking about a domain: who they are, and the shelf they asked from. */
export interface DomainActor {
    readonly userId: string;
    readonly isAdmin: boolean;
    /** The owner whose domain page this is, or null for the administrator's list. */
    readonly owner: DomainOwner | null;
}

/** A refusal whose message is a key in the `domainSecurity` catalog. */
export class DomainSecurityError extends Error {
    constructor(
        readonly key:
            | "errors.notFound"
            | "errors.cannotFix"
            | "errors.planChanged"
            | "errors.tooSoon"
    ) {
        super(key);
        this.name = "DomainSecurityError";
    }
}

/** A re-check closer to the last one than this answers the stored audit. */
const RECHECK_GAP_MS = 60 * 1000;
/** The daily pass re-audits a domain whose audit is older than this. */
const STALE_MS = 20 * 60 * 60 * 1000;
/** Domains one run of the pass audits; the pass runs hourly, so this is a day's
 *  worth for several hundred domains without one run ever taking long. */
const PER_RUN = 25;
/** How far back sending sources are read. */
const SOURCES_DAYS = 30;

interface Access {
    readonly known: KnownDomain;
    readonly scope: zones.DnsScope | null;
    /** For DNSSEC: the token and zone, when the zone is the domain itself. */
    readonly signing: { readonly token: string; readonly zoneId: string } | null;
}

function ownsRow(owner: DomainOwner, row: NonNullable<KnownDomain["ownerDomain"]>): boolean {
    return owner.kind === "user" ? row.userId === owner.id : row.orgId === owner.id;
}

/** Whose token writes a domain's zone: the brought domain's own, or the
 *  instance's Cloudflare account. */
type ScopeKind = "owner" | "instance";

const NO_SCOPE: Pick<Access, "scope" | "signing"> = { scope: null, signing: null };

/** How Polaris writes a known domain's zone with one token, never the other in
 *  its place when that one cannot be used. */
async function scopeWith(
    known: KnownDomain,
    kind: ScopeKind
): Promise<Pick<Access, "scope" | "signing">> {
    if (kind === "owner") {
        if (!known.ownerDomain?.hasToken) return NO_SCOPE;
        const row = await prisma.ownerDomain.findUnique({
            where: { id: known.ownerDomain.id },
            select: { dnsToken: true }
        });
        const token = openText(row?.dnsToken ?? null);
        if (!token) return NO_SCOPE;
        const owner: DomainOwner = known.ownerDomain.orgId
            ? { kind: "org", id: known.ownerDomain.orgId }
            : { kind: "user", id: known.ownerDomain.userId ?? "" };
        const zone = await cf.resolveZoneForHostname(token, known.domain).catch(() => null);
        return {
            scope: { kind: "owner", owner, domainId: known.ownerDomain.id },
            signing: zone && zone.name === known.domain ? { token, zoneId: zone.id } : null
        };
    }
    if (!known.zone) return NO_SCOPE;
    const token = await loadCloudflareToken().catch(() => null);
    if (!token) return NO_SCOPE;
    return {
        scope: { kind: "instance", zoneId: known.zone.id },
        signing: known.zone.name === known.domain ? { token, zoneId: known.zone.id } : null
    };
}

/** How the daily pass reads a domain's zone for its audit: the brought domain's
 *  own token first, then the instance's. Reading only - writes use the scope
 *  that dedicated the domain. */
async function readScope(known: KnownDomain): Promise<Pick<Access, "scope" | "signing">> {
    const own = await scopeWith(known, "owner");
    return own.scope ? own : scopeWith(known, "instance");
}

function scopeKindOf(value: string | null): ScopeKind | null {
    return value === "owner" || value === "instance" ? value : null;
}

/**
 * What one person may do with one domain. "Not yours" reads exactly like "not
 * there", so a name cannot be used to learn what Polaris knows.
 */
async function accessFor(actor: DomainActor, domain: string): Promise<Access> {
    const known = await knownDomain(domain);
    if (!known) throw new DomainSecurityError("errors.notFound");
    if (actor.owner) {
        if (!known.ownerDomain || !ownsRow(actor.owner, known.ownerDomain))
            throw new DomainSecurityError("errors.notFound");
        // The owner's page writes with the owner's token, never the instance's.
        return { known, ...(await scopeWith(known, "owner")) };
    }
    if (!actor.isAdmin) throw new DomainSecurityError("errors.notFound");
    // The administrator's list writes with the instance's token only.
    return { known, ...(await scopeWith(known, "instance")) };
}

async function zoneRecordsFor(
    scope: zones.DnsScope | null,
    domain: string
): Promise<ZoneRecordLike[] | null> {
    if (!scope) return null;
    try {
        const zone = await zones.zoneRecords(scope);
        return zone.records
            .filter((record) => record.name === domain || record.name.endsWith(`.${domain}`))
            .map((record) => ({
                id: record.id,
                type: record.type,
                name: record.name,
                content: record.content,
                priority: record.priority
            }));
    } catch {
        return null;
    }
}

function reportAddressFor(known: KnownDomain): string | null {
    return known.mailServers.some((server) => server.reports)
        ? `${core.MAIL_REPORTS_NAME}@${known.domain}`
        : null;
}

/** Audit one domain now, store it, and answer it with the one it replaced. */
async function audit(
    known: KnownDomain,
    access: Pick<Access, "scope" | "signing">,
    probes?: Probes
): Promise<{ report: SecurityReport; previous: SecurityReport | null }> {
    const records = await zoneRecordsFor(access.scope, known.domain);
    const dnssec = access.signing
        ? await cf.getZoneDnssec(access.signing.token, access.signing.zoneId).catch(() => null)
        : null;
    const aliases = records
        ? records
              .filter((record) => record.type === "CNAME")
              .map((record) => ({ name: record.name, target: record.content }))
        : [
              ...new Set([`www.${known.domain}`, ...known.hostnames.map((entry) => entry.hostname)])
          ].map((name) => ({ name }));
    const servers = known.mailServers;
    const facts = await collectFacts(
        {
            domain: known.domain,
            context: {
                polarisIssues:
                    known.sources.includes("owner") ||
                    known.sources.includes("instance") ||
                    known.hostnames.some((entry) => entry.le),
                polarisZone: known.sources.includes("owner") || known.sources.includes("instance"),
                mailServerSpf: servers.find((server) => server.spf)?.spf ?? null,
                reportAddress: reportAddressFor(known),
                dsRecord: dnssec?.ds ?? null
            },
            selectors: [...new Set(servers.flatMap((server) => server.selectors))],
            aliases,
            servedByPolaris: known.hostnames.some((entry) => entry.hostname === known.domain)
        },
        probes ?? (await import("./probes")).liveProbes()
    );
    const report = evaluate(facts);
    const row = await prisma.domainSecurityAudit.findUnique({
        where: { domain: known.domain },
        select: { report: true }
    });
    const previous = row ? readReport(row.report) : null;
    await prisma.domainSecurityAudit.upsert({
        where: { domain: known.domain },
        create: {
            domain: known.domain,
            grade: report.grade,
            report: report as unknown as object,
            checkedAt: new Date(report.checkedAt)
        },
        update: {
            grade: report.grade,
            report: report as unknown as object,
            checkedAt: new Date(report.checkedAt)
        }
    });
    return { report, previous };
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export interface AutoFixSummary {
    readonly at: string;
    readonly applied: number;
    readonly failed: number;
}

export interface DomainSecurityView {
    readonly domain: string;
    readonly report: SecurityReport | null;
    readonly dedicated: boolean;
    readonly lastAutoFix: AutoFixSummary | null;
    /** Whether Polaris can write this domain's zone for this person. */
    readonly canFix: boolean;
    /** Where its DMARC reports are read, when Polaris reads them. */
    readonly reportAddress: string | null;
    /** Who sent as it over the last month, when Polaris reads its reports. */
    readonly sources: readonly SendingSource[] | null;
}

function autoFixOf(value: unknown): AutoFixSummary | null {
    const body = value as { at?: unknown; applied?: unknown; failed?: unknown } | null;
    if (!body || typeof body.at !== "string") return null;
    return { at: body.at, applied: Number(body.applied) || 0, failed: Number(body.failed) || 0 };
}

/** How long a source's reverse name is remembered: a sender's name rarely moves,
 *  and every panel read would otherwise ask again. */
const REVERSE_TTL_MS = 6 * 60 * 60 * 1000;
const reverseCache = new Map<string, { at: number; name: string | null }>();

async function reverseName(ip: string): Promise<string | null> {
    const cached = reverseCache.get(ip);
    if (cached && Date.now() - cached.at < REVERSE_TTL_MS) return cached.name;
    const name =
        (
            await publicResolver()
                .reverse(ip)
                .catch(() => [] as string[])
        )[0] ?? null;
    if (reverseCache.size > 5000) reverseCache.clear();
    reverseCache.set(ip, { at: Date.now(), name });
    return name;
}

/** Each source's reverse name, a few at a time and each bounded by the resolver's
 *  own timeout - the name is what says "Google" where the address does not. */
async function namedSources(sources: SendingSource[]): Promise<SendingSource[]> {
    const named: SendingSource[] = [];
    for (let start = 0; start < sources.length; start += 8) {
        named.push(
            ...(await Promise.all(
                sources.slice(start, start + 8).map(async (source) => ({
                    ...source,
                    hostname: await reverseName(source.sourceIp)
                }))
            ))
        );
    }
    return named;
}

async function sourcesFor(domain: string): Promise<SendingSource[] | null> {
    const since = new Date(Date.now() - SOURCES_DAYS * 24 * 60 * 60 * 1000);
    const rows = await prisma.mailDmarcReport.findMany({
        where: { domain, endAt: { gte: since } },
        orderBy: { endAt: "desc" },
        take: 1000
    });
    if (rows.length === 0) return null;
    return namedSources(sendingSources(rows.map(storedReport)).slice(0, 20));
}

async function viewOf(access: Access): Promise<DomainSecurityView> {
    const domain = access.known.domain;
    const row = await prisma.domainSecurityAudit.findUnique({ where: { domain } });
    const reportAddress = reportAddressFor(access.known);
    return {
        domain,
        report: row ? readReport(row.report) : null,
        dedicated: row?.dedicated ?? false,
        lastAutoFix: autoFixOf(row?.lastAutoFix ?? null),
        canFix: access.scope !== null,
        reportAddress,
        sources: reportAddress ? await sourcesFor(domain) : null
    };
}

export async function domainSecurityView(
    actor: DomainActor,
    domain: string
): Promise<DomainSecurityView> {
    return viewOf(await accessFor(actor, domain));
}

/** Audit again now, unless the last audit was a moment ago. */
export async function recheckDomain(
    actor: DomainActor,
    domain: string
): Promise<DomainSecurityView> {
    const access = await accessFor(actor, domain);
    const row = await prisma.domainSecurityAudit.findUnique({
        where: { domain: access.known.domain },
        select: { checkedAt: true }
    });
    if (row?.checkedAt && Date.now() - row.checkedAt.getTime() < RECHECK_GAP_MS)
        return viewOf(access);
    await audit(access.known, access);
    return viewOf(access);
}

export interface GradeSummary {
    readonly grade: Grade;
    readonly checkedAt: string | null;
    /** Findings at low or worse - the same count the card shows. */
    readonly problems: number;
}

/** The badge of each domain, from one query. */
export async function gradesFor(domains: readonly string[]): Promise<Record<string, GradeSummary>> {
    if (domains.length === 0) return {};
    const rows = await prisma.domainSecurityAudit.findMany({
        where: { domain: { in: domains.map((domain) => domain.toLowerCase()) } },
        select: { domain: true, report: true, checkedAt: true }
    });
    const out: Record<string, GradeSummary> = {};
    for (const row of rows) {
        const report = readReport(row.report);
        if (!report) continue;
        out[row.domain] = {
            grade: report.grade,
            checkedAt: row.checkedAt?.toISOString() ?? null,
            problems: report.findings.filter(
                (finding) => !["pass", "info"].includes(finding.severity)
            ).length
        };
    }
    return out;
}

export interface InventoryEntry {
    readonly domain: string;
    readonly sources: readonly string[];
    readonly grade: GradeSummary | null;
}

/** Every known domain with its badge: the administrator's list. */
export async function securityInventory(actor: DomainActor): Promise<InventoryEntry[]> {
    if (!actor.isAdmin) return [];
    const known = await knownDomains();
    const grades = await gradesFor(known.map((entry) => entry.domain));
    return known.map((entry) => ({
        domain: entry.domain,
        sources: entry.sources,
        grade: grades[entry.domain] ?? null
    }));
}

// ---------------------------------------------------------------------------
// Fixing
// ---------------------------------------------------------------------------

async function edgeTargets(known: KnownDomain): Promise<EdgeTarget[]> {
    const names = new Set([known.domain, `www.${known.domain}`]);
    const hosts = known.hostnames.filter((entry) => names.has(entry.hostname));
    if (hosts.length === 0) return [];
    const apps = await prisma.application.findMany({
        where: { id: { in: [...new Set(hosts.map((entry) => entry.applicationId))] } },
        select: { id: true, edgeConfig: true }
    });
    return hosts.flatMap((host) => {
        const app = apps.find((entry) => entry.id === host.applicationId);
        if (!app) return [];
        return [
            {
                applicationId: app.id,
                hostname: host.hostname,
                preset: core.parseAppEdgeConfig(app.edgeConfig).headers.preset
            }
        ];
    });
}

async function planWith(
    access: Access,
    report: SecurityReport,
    dmarcPolicy: "quarantine" | "reject" | null
): Promise<PlannedChange[]> {
    return planChanges({
        report,
        records: await zoneRecordsFor(access.scope, access.known.domain),
        canSign: access.signing !== null,
        edge: await edgeTargets(access.known),
        reportAddress: reportAddressFor(access.known),
        dmarcPolicy
    });
}

/** What Polaris would change for this person, from the audit they are looking at. */
export async function planFor(
    actor: DomainActor,
    domain: string,
    dmarcPolicy: "quarantine" | "reject" | null
): Promise<PlannedChange[]> {
    const access = await accessFor(actor, domain);
    const row = await prisma.domainSecurityAudit.findUnique({
        where: { domain: access.known.domain },
        select: { report: true }
    });
    const report = row ? readReport(row.report) : null;
    if (!report) return [];
    return planWith(access, report, dmarcPolicy);
}

/** A record change as the DNS editor's form holds it, so it is checked by the
 *  same schema a typed record is. */
function draftFor(change: PlannedChange): DnsRecordDraft {
    const draft = emptyDraft(change.type ?? "TXT");
    if (change.type === "CAA") {
        const match = /^(\d+)\s+(\S+)\s+"?([^"]*)"?$/.exec(change.after ?? "");
        return {
            ...draft,
            name: change.name,
            flags: match?.[1] ?? "0",
            tag: match?.[2] ?? "issue",
            value: match?.[3] ?? ""
        };
    }
    if (change.type === "MX")
        return { ...draft, name: change.name, content: change.after ?? ".", priority: "0" };
    return { ...draft, name: change.name, content: change.after ?? "" };
}

export interface ChangeResult {
    readonly id: string;
    readonly ok: boolean;
    /** Why it was not made, in the words the DNS host or Polaris gave. */
    readonly detail: string | null;
}

async function carryOut(
    access: Access,
    change: PlannedChange,
    actorId: string | null
): Promise<ChangeResult> {
    try {
        if (change.kind === "dnssec") {
            if (!access.signing) throw new DomainSecurityError("errors.cannotFix");
            await cf.enableZoneDnssec(access.signing.token, access.signing.zoneId);
        } else if (change.kind === "edge") {
            if (!actorId || !change.applicationId)
                throw new DomainSecurityError("errors.cannotFix");
            const { requireApplicationAccess } = await import("@/lib/deploy-project-access");
            const deploy = await import("@/lib/deploy-service");
            const granted = await requireApplicationAccess(
                change.applicationId,
                actorId,
                "domains.manage"
            );
            const app = await prisma.application.findUnique({
                where: { id: change.applicationId },
                select: { edgeConfig: true }
            });
            const config = core.parseAppEdgeConfig(app?.edgeConfig ?? null);
            await deploy.setApplicationEdgeConfig(change.applicationId, granted.ownerId, {
                ...config,
                headers: { ...config.headers, preset: "recommended" }
            });
        } else {
            if (!access.scope) throw new DomainSecurityError("errors.cannotFix");
            if (change.action === "delete" && change.recordId)
                await zones.deleteZoneRecord(access.scope, change.recordId);
            else
                await zones.saveZoneRecord(
                    access.scope,
                    change.action === "update" ? change.recordId : null,
                    draftFor(change)
                );
        }
        return { id: change.id, ok: true, detail: null };
    } catch (error) {
        const detail =
            error instanceof zones.DnsEditError || error instanceof cf.CloudflareApiError
                ? error.message.slice(0, 300)
                : error instanceof DomainSecurityError
                  ? error.key
                  : null;
        if (detail === null) console.error("polaris: a domain security fix failed:", error);
        return { id: change.id, ok: false, detail };
    }
}

/**
 * Make the changes a person approved. Approved by fingerprint - the change as it
 * was shown - so a plan that moved since (a record edited in another tab) is
 * refused for that change rather than applied over what is there now.
 */
export async function applyFor(
    actor: DomainActor,
    domain: string,
    approved: readonly string[],
    dmarcPolicy: "quarantine" | "reject" | null
): Promise<{ results: ChangeResult[]; view: DomainSecurityView }> {
    const access = await accessFor(actor, domain);
    const row = await prisma.domainSecurityAudit.findUnique({
        where: { domain: access.known.domain },
        select: { report: true }
    });
    const report = row ? readReport(row.report) : null;
    if (!report) throw new DomainSecurityError("errors.planChanged");
    const wanted = new Set(approved);
    const plan = await planWith(access, report, dmarcPolicy);
    const chosen = plan.filter((change) => wanted.has(fingerprint(change)));
    if (chosen.length !== wanted.size) throw new DomainSecurityError("errors.planChanged");
    const results: ChangeResult[] = [];
    for (const change of chosen) results.push(await carryOut(access, change, actor.userId));
    await audit(access.known, access).catch(() => undefined);
    return { results, view: await viewOf(access) };
}

/** Hand a domain's safe fixes to Polaris, or take them back. Only somebody who
 *  can fix it may. */
export async function setDedicated(
    actor: DomainActor,
    domain: string,
    dedicated: boolean
): Promise<DomainSecurityView> {
    const access = await accessFor(actor, domain);
    if (!access.scope) throw new DomainSecurityError("errors.cannotFix");
    const by = {
        dedicatedBy: dedicated ? actor.userId : null,
        dedicatedScope: dedicated ? access.scope.kind : null
    };
    await prisma.domainSecurityAudit.upsert({
        where: { domain: access.known.domain },
        create: { domain: access.known.domain, dedicated, ...by },
        update: { dedicated, ...by }
    });
    return viewOf(access);
}

// ---------------------------------------------------------------------------
// The daily pass
// ---------------------------------------------------------------------------

/** Who answers for a domain: its owner (or the organization's domain managers),
 *  and the administrators for anything instance-wide. */
async function recipientsFor(known: KnownDomain): Promise<{ userId: string; href: string }[]> {
    const out = new Map<string, string>();
    if (known.ownerDomain?.orgId) {
        const org = await prisma.organization.findUnique({
            where: { id: known.ownerDomain.orgId },
            select: { slug: true }
        });
        const href = org ? `/account/organizations/${org.slug}/domains` : "/account/domains";
        for (const userId of await orgPeopleHolding(known.ownerDomain.orgId, "domains.manage"))
            out.set(userId, href);
    } else if (known.ownerDomain?.userId) {
        out.set(known.ownerDomain.userId, "/account/domains");
    }
    if (known.sources.some((source) => source !== "owner")) {
        const admins = await prisma.user.findMany({
            where: { isAdmin: true, bannedAt: null, disabledAt: null },
            select: { id: true }
        });
        for (const admin of admins) if (!out.has(admin.id)) out.set(admin.id, "/admin/domains");
    }
    return [...out.entries()].map(([userId, href]) => ({ userId, href }));
}

async function tell(known: KnownDomain, worse: number, fixed: number): Promise<void> {
    for (const recipient of await recipientsFor(known)) {
        const t = await wordsFor(recipient.userId, "domainSecurity");
        await notify({
            userId: recipient.userId,
            event: "domain.security",
            title:
                worse > 0
                    ? t("notice.worse", { domain: known.domain, count: worse })
                    : t("notice.fixed", { domain: known.domain, count: fixed }),
            body: worse > 0 ? t("notice.worseBody", { fixed }) : t("notice.fixedBody"),
            href: recipient.href,
            level: worse > 0 ? "warning" : "success",
            actionRequired: worse > 0
        }).catch(() => undefined);
    }
}

/** The safe fixes for a domain handed to Polaris, made with nobody asking and
 *  only with the token of whoever handed it over. */
async function autoFix(
    known: KnownDomain,
    report: SecurityReport,
    dedicated: { by: string | null; scope: ScopeKind | null }
): Promise<AutoFixSummary | null> {
    if (!dedicated.scope) return null;
    const system = await scopeWith(known, dedicated.scope);
    if (!system.scope) return null;
    const access: Access = { known, ...system };
    const changes = automaticChanges(await planWith(access, report, null));
    if (changes.length === 0) return null;
    const results: ChangeResult[] = [];
    for (const change of changes) results.push(await carryOut(access, change, dedicated.by));
    const summary = {
        at: new Date().toISOString(),
        applied: results.filter((result) => result.ok).length,
        failed: results.filter((result) => !result.ok).length
    };
    await prisma.domainSecurityAudit.update({
        where: { domain: known.domain },
        data: { lastAutoFix: summary as unknown as object }
    });
    return summary;
}

/**
 * One run of the daily pass: the stalest few domains audited, regressions told,
 * dedicated domains fixed. Never throws for one domain - the next still runs.
 */
export async function runDomainSecuritySweep(
    probes?: Probes
): Promise<{ audited: number; told: number; fixed: number }> {
    const known = await knownDomains({ resolveParents: true });
    if (known.length === 0) return { audited: 0, told: 0, fixed: 0 };
    const rows = await prisma.domainSecurityAudit.findMany({
        where: { domain: { in: known.map((entry) => entry.domain) } },
        select: {
            domain: true,
            checkedAt: true,
            dedicated: true,
            dedicatedBy: true,
            dedicatedScope: true
        }
    });
    const byDomain = new Map(rows.map((row) => [row.domain, row]));
    const due = known
        .filter((entry) => {
            const checked = byDomain.get(entry.domain)?.checkedAt;
            return !checked || Date.now() - checked.getTime() > STALE_MS;
        })
        .sort(
            (a, b) =>
                (byDomain.get(a.domain)?.checkedAt?.getTime() ?? 0) -
                (byDomain.get(b.domain)?.checkedAt?.getTime() ?? 0)
        )
        .slice(0, PER_RUN);
    let told = 0;
    let fixed = 0;
    for (const entry of due) {
        try {
            const system = await readScope(entry);
            const first = await audit(entry, system, probes);
            const previous = first.previous;
            let report = first.report;
            const row = byDomain.get(entry.domain);
            let applied = 0;
            if (row?.dedicated) {
                const summary = await autoFix(entry, report, {
                    by: row.dedicatedBy,
                    scope: scopeKindOf(row.dedicatedScope)
                });
                if (summary && summary.applied > 0) {
                    applied = summary.applied;
                    fixed += applied;
                    // What is left after the fixes is what anybody needs telling about.
                    report = (await audit(entry, system, probes)).report;
                }
            }
            const worse = regressions(previous?.findings ?? null, report.findings).length;
            if (worse > 0 || applied > 0) {
                await tell(entry, worse, applied);
                told += 1;
            }
        } catch (error) {
            console.error(`polaris: auditing ${entry.domain} failed:`, error);
        }
    }
    return { audited: due.length, told, fixed };
}
