/**
 * A mail domain's DNS: what the engine expects, what the world sees, and
 * publishing the difference through the operator's Cloudflare account.
 *
 * What the world sees is asked of public resolvers by name, not of whatever
 * resolver this machine is configured with. A home router's resolver answers
 * from a cache, and an office one may answer a split-horizon zone - either can
 * say a record is there when a receiving mail server on the internet will not
 * find it. The question is what the internet sees, so the internet is asked.
 *
 * Publishing is a plan first. Every record is compared with what the zone holds
 * and given one of: create, update (only ever to add this server to an SPF that
 * exists, or on the operator's say-so), unchanged, or conflict - something else
 * is at that name, and it stays there unless the operator asks otherwise. Mail
 * that already goes somewhere is never moved without being asked.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { relaySpfInclude } from "./relay";
import { Resolver } from "node:dns/promises";
import type { MailServer } from "@polaris/db";
import { publishWithin } from "./dns-standing";
import { recordAudit } from "@/lib/audit-service";
import { listDomains, type MailDomainView } from "./operations";
import { MailServerAccessError, type MailServerActor } from "./access";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";
import {
    createZoneRecord,
    listZoneRecords,
    resolveZoneForHostname,
    updateZoneRecord
} from "@/lib/integrations/cloudflare-api";

/** The resolvers asked, two operators so one having a bad day is not the answer. */
const PUBLIC_RESOLVERS = ["1.1.1.1", "8.8.8.8"];

function publicResolver(): Resolver {
    const resolver = new Resolver({ timeout: 4000, tries: 2 });
    resolver.setServers(PUBLIC_RESOLVERS);
    return resolver;
}

/** What a public resolver says is at one name, in the shape the zone writes it. */
export async function publishedValues(
    resolver: Resolver,
    record: core.ZoneRecord
): Promise<string[] | null> {
    try {
        switch (record.type) {
            case "MX":
                return (await resolver.resolveMx(record.name)).map((entry) => entry.exchange);
            case "TXT":
                return (await resolver.resolveTxt(record.name)).map((chunks) => chunks.join(""));
            case "CNAME":
                return await resolver.resolveCname(record.name);
            case "SRV":
                return (await resolver.resolveSrv(record.name)).map(
                    (entry) => `${entry.priority} ${entry.weight} ${entry.port} ${entry.name}`
                );
            case "CAA":
                return (await resolver.resolveCaa(record.name)).map((entry) => {
                    const [tag, value] = Object.entries(entry).find(
                        ([key]) => key !== "critical"
                    ) ?? ["", ""];
                    return `${entry.critical} ${tag} ${String(value)}`;
                });
            case "A":
                return await resolver.resolve4(record.name);
            case "AAAA":
                return await resolver.resolve6(record.name);
            default:
                // TLSA and friends: nothing here can ask for them.
                return null;
        }
    } catch (error) {
        const code = (error as { code?: string }).code;
        // "No such name" and "no data" are answers: nothing is published.
        if (code === "ENOTFOUND" || code === "ENODATA") return [];
        throw error;
    }
}

export interface DomainDnsReport {
    readonly domain: string;
    readonly verdict: core.RecordVerdict;
    readonly records: readonly (core.GradedRecord & { readonly checkable: boolean })[];
}

/**
 * The expected records of one domain, read from the engine's zone. A server that
 * sends through a relay also needs the relay's provider in its SPF, or every
 * message the relay delivers fails the check the engine's own SPF passes.
 */
export function expectedFor(
    domain: MailDomainView,
    spfInclude: string | null
): core.ExpectedMailRecord[] {
    return core
        .expectedMailRecords(core.parseZoneFile(domain.zoneFile, domain.name))
        .map((record) =>
            record.purpose === "spf" && spfInclude
                ? {
                      ...record,
                      value: core.mergeSpf(record.value, `v=spf1 ${spfInclude}`) ?? record.value
                  }
                : record
        );
}

/**
 * Grade every domain on the server against what is published, and keep the
 * answer on the row so the screen opens on it next time.
 */
export async function scanDns(server: MailServer): Promise<DomainDnsReport[]> {
    const resolver = publicResolver();
    const include = relaySpfInclude(server);
    const reports: DomainDnsReport[] = [];
    for (const domain of await listDomains(server)) {
        const graded: (core.GradedRecord & { checkable: boolean })[] = [];
        for (const record of expectedFor(domain, include)) {
            const published = await publishedValues(resolver, record).catch(() => undefined);
            if (published === undefined) {
                graded.push({
                    record,
                    verdict: "warn",
                    published: [],
                    note: "The public resolvers did not answer for this name.",
                    checkable: true
                });
            } else if (published === null) {
                graded.push({
                    record,
                    verdict: "warn",
                    published: [],
                    note: "Polaris cannot look this record type up.",
                    checkable: false
                });
            } else {
                graded.push({ ...core.gradeRecord(record, published), checkable: true });
            }
        }
        // A record nothing here can look up does not make the domain's badge amber.
        reports.push({
            domain: domain.name,
            verdict: core.overallVerdict(graded.filter((entry) => entry.checkable)),
            records: graded
        });
    }
    await prisma.mailServer.update({
        where: { id: server.id },
        data: { lastDns: JSON.stringify({ at: new Date().toISOString(), reports }) }
    });
    return reports;
}

const verdictSchema = z.enum(["pass", "warn", "fail"]);

/** A stored scan is older than this code; one that no longer reads is dropped
 *  and the next scan writes it again. */
const storedDnsSchema = z.object({
    at: z.string(),
    reports: z.array(
        z.object({
            domain: z.string(),
            verdict: verdictSchema,
            records: z.array(
                z.object({
                    record: z.object({
                        name: z.string(),
                        type: z.string(),
                        ttl: z.number().nullable().catch(null),
                        value: z.string(),
                        priority: z.number().nullable().catch(null),
                        purpose: z.string(),
                        required: z.boolean().catch(false)
                    }),
                    verdict: verdictSchema,
                    published: z.array(z.string()).catch([]),
                    note: z.string().nullable().catch(null),
                    checkable: z.boolean().catch(true)
                })
            )
        })
    )
});

/** The last scan, as it was stored. */
export function storedDns(server: MailServer): { at: string; reports: DomainDnsReport[] } | null {
    if (!server.lastDns) return null;
    try {
        const parsed = storedDnsSchema.safeParse(JSON.parse(server.lastDns));
        if (!parsed.success) return null;
        return {
            at: parsed.data.at,
            reports: parsed.data.reports.map((report) => ({
                ...report,
                records: report.records.map((entry) => ({
                    ...entry,
                    record: { ...entry.record, purpose: core.purposeOf(entry.record) }
                }))
            }))
        };
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Publishing through Cloudflare
// ---------------------------------------------------------------------------

export type PlanAction = "create" | "update" | "unchanged" | "conflict" | "skip";

export interface PlannedRecord {
    readonly record: core.ExpectedMailRecord;
    readonly action: PlanAction;
    /** The value that would be written, when it is not the expected one (a
     *  merged SPF). */
    readonly value: string;
    /** What is there now, for a conflict or an update. */
    readonly existing: readonly string[];
    readonly existingId: string | null;
    readonly note: string | null;
}

export interface DnsPlan {
    readonly domain: string;
    readonly zoneId: string;
    readonly records: readonly PlannedRecord[];
}

/** The Cloudflare token, or the sentence that says how to connect one. */
async function cloudflareToken(): Promise<string> {
    const token = await loadCloudflareToken();
    if (!token)
        throw new MailServerAccessError(
            "Connect a Cloudflare API token under Integrations to publish records from here."
        );
    return token;
}

/** Whether a record's name is at or under a domain. */
function atOrUnder(name: string, domain: string): boolean {
    const bare = name.trim().toLowerCase().replace(/\.+$/, "");
    return bare === domain || bare.endsWith(`.${domain}`);
}

/**
 * Compare one domain's expected records with its Cloudflare zone. Only for a
 * caller the operator's token may write for (see `dns-standing`), and only the
 * records at or under the domain they verified.
 */
export async function planDns(
    actor: MailServerActor,
    server: MailServer,
    domainId: string
): Promise<DnsPlan> {
    const domain = (await listDomains(server)).find((one) => one.id === domainId);
    if (!domain) throw new MailServerAccessError("That domain is not on this mail server.");
    const within = await publishWithin(actor, server.orgId, domain.name);
    const token = await cloudflareToken();
    const zone = await resolveZoneForHostname(token, domain.name).catch(() => {
        throw new MailServerAccessError(
            `${domain.name} is not a zone in the Cloudflare account Polaris is connected to.`
        );
    });
    const planned: PlannedRecord[] = [];
    for (const record of expectedFor(domain, relaySpfInclude(server))) {
        if (record.type === "TLSA") {
            planned.push({
                record,
                action: "skip",
                value: record.value,
                existing: [],
                existingId: null,
                note: "Only meaningful on a zone signed with DNSSEC; publish it yourself if yours is."
            });
            continue;
        }
        if (within && !atOrUnder(record.name, within)) {
            planned.push({
                record,
                action: "skip",
                value: record.value,
                existing: [],
                existingId: null,
                note: `Outside ${within}; add it at your DNS host.`
            });
            continue;
        }
        const existing = await listZoneRecords(token, zone.id, record.type, record.name);
        const values = existing.map((row) => row.content);
        const same = (value: string) =>
            core.gradeRecord({ ...record, value }, [record.value]).verdict === "pass";

        if (record.purpose === "spf") {
            const spf = existing.find((row) => row.content.toLowerCase().startsWith("v=spf1"));
            if (!spf) {
                planned.push({
                    record,
                    action: "create",
                    value: record.value,
                    existing: [],
                    existingId: null,
                    note: null
                });
                continue;
            }
            const merged = core.mergeSpf(spf.content, record.value);
            planned.push(
                merged === null
                    ? {
                          record,
                          action: "unchanged",
                          value: spf.content,
                          existing: [spf.content],
                          existingId: spf.id,
                          note: "The SPF already published covers this server."
                      }
                    : {
                          record,
                          action: "update",
                          value: merged,
                          existing: [spf.content],
                          existingId: spf.id,
                          note: "Adds this server to the SPF already published, keeping everything in it."
                      }
            );
            continue;
        }
        if (record.purpose === "dmarc") {
            const dmarc = existing.find((row) => row.content.toLowerCase().startsWith("v=dmarc1"));
            planned.push(
                dmarc
                    ? {
                          record,
                          action: "unchanged",
                          value: dmarc.content,
                          existing: [dmarc.content],
                          existingId: dmarc.id,
                          note: "A DMARC policy is already published; it is kept."
                      }
                    : {
                          record,
                          action: "create",
                          value: record.value,
                          existing: [],
                          existingId: null,
                          note: null
                      }
            );
            continue;
        }
        const matching = existing.find((row) => same(row.content));
        if (matching) {
            planned.push({
                record,
                action: "unchanged",
                value: record.value,
                existing: values,
                existingId: matching.id,
                note: null
            });
        } else if (existing.length === 0 || (record.type === "TXT" && record.purpose === "other")) {
            planned.push({
                record,
                action: "create",
                value: record.value,
                existing: values,
                existingId: null,
                note: null
            });
        } else {
            planned.push({
                record,
                action: "conflict",
                value: record.value,
                existing: values,
                existingId: existing[0]?.id ?? null,
                note:
                    record.purpose === "mx"
                        ? "Mail for this domain goes somewhere else today. It is left there unless you replace it."
                        : "Something else is published at this name. It is left there unless you replace it."
            });
        }
    }
    return { domain: domain.name, zoneId: zone.id, records: planned };
}

export interface ApplyResult {
    readonly name: string;
    readonly type: string;
    readonly outcome: "created" | "updated" | "unchanged" | "left" | "failed";
    readonly note: string | null;
}

/**
 * Carry a plan out. Conflicts are left alone unless `replaceConflicts` - the
 * operator's explicit answer to the question the plan asked. Each record stands
 * on its own: one Cloudflare refusal is reported and the rest still go.
 */
export async function applyDns(
    actor: MailServerActor,
    server: MailServer,
    domainId: string,
    replaceConflicts: boolean
): Promise<ApplyResult[]> {
    const plan = await planDns(actor, server, domainId);
    const token = await cloudflareToken();
    const results: ApplyResult[] = [];
    for (const entry of plan.records) {
        const base = { name: entry.record.name, type: entry.record.type };
        const body = {
            type: entry.record.type,
            name: entry.record.name,
            value: entry.value,
            priority: entry.record.priority
        };
        try {
            if (entry.action === "create") {
                await createZoneRecord(token, plan.zoneId, body);
                results.push({ ...base, outcome: "created", note: null });
            } else if (entry.action === "update" && entry.existingId) {
                await updateZoneRecord(token, plan.zoneId, entry.existingId, body);
                results.push({ ...base, outcome: "updated", note: entry.note });
            } else if (entry.action === "conflict" && replaceConflicts && entry.existingId) {
                await updateZoneRecord(token, plan.zoneId, entry.existingId, body);
                results.push({
                    ...base,
                    outcome: "updated",
                    note: `Replaced ${entry.existing.join(", ")}`
                });
            } else if (entry.action === "unchanged") {
                results.push({ ...base, outcome: "unchanged", note: entry.note });
            } else {
                results.push({ ...base, outcome: "left", note: entry.note });
            }
        } catch (error) {
            results.push({
                ...base,
                outcome: "failed",
                note: error instanceof Error ? error.message : "Cloudflare refused it"
            });
        }
    }
    await recordAudit({
        actorId: actor.id,
        action: "mailserver.dns.publish",
        targetType: "mail-server",
        targetId: server.id,
        orgId: server.orgId ?? undefined
    });
    return results;
}
