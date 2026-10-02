/**
 * Every domain Polaris knows about, and why it knows it.
 *
 * A domain arrives here five ways, and one domain can arrive several of them at
 * once: the instance's own base domain, a zone on the connected Cloudflare
 * account, a domain somebody brought for their deploys (verified), a domain a
 * Polaris mail server receives for, and the parent of a hostname a service is
 * deployed on. Each is audited once, under the name it is registered or
 * delegated at.
 *
 * Bounded: one query per kind, the Cloudflare zone list cached, and the parent
 * of a deployed hostname worked out once and remembered. Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { getDomainZones } from "@/lib/domain-zones";
import { editableZones } from "@/lib/dns/zone-records";
import { storedDns } from "@/lib/mail-server/dns";
import { publicResolver } from "@/lib/dns/public-resolver";

export type DomainSource = "instance" | "cloudflare" | "owner" | "mail-server" | "deploy";

export interface KnownDomain {
    readonly domain: string;
    readonly sources: readonly DomainSource[];
    /** The brought domain's row, when it is one. */
    readonly ownerDomain: {
        readonly id: string;
        readonly userId: string | null;
        readonly orgId: string | null;
        readonly hasToken: boolean;
    } | null;
    /** The Cloudflare zone holding it on the instance's account, when one does. */
    readonly zone: { readonly id: string; readonly name: string } | null;
    readonly mailServers: readonly {
        readonly id: string;
        readonly ownerId: string;
        readonly orgId: string | null;
        readonly reports: boolean;
        readonly spf: string | null;
        readonly selectors: readonly string[];
    }[];
    /** Hostnames under it that a service answers on. */
    readonly hostnames: readonly {
        readonly hostname: string;
        readonly applicationId: string;
        readonly le: boolean;
    }[];
}

/** Names that are somebody else's shared domain, never one to audit as ours. */
const SHARED_SUFFIXES = [
    "sslip.io",
    "nip.io",
    "traefik.me",
    "duckdns.org",
    "trycloudflare.com",
    "cfargotunnel.com",
    "ngrok.io",
    "ngrok-free.app",
    "ngrok.app",
    "local"
];

function shared(name: string): boolean {
    return SHARED_SUFFIXES.some((suffix) => name === suffix || name.endsWith(`.${suffix}`));
}

function clean(name: string): string {
    return name.trim().toLowerCase().replace(/\.+$/, "").replace(/^\*\./, "");
}

function under(name: string, domain: string): boolean {
    return name === domain || name.endsWith(`.${domain}`);
}

const ZONE_TTL_MS = 10 * 60 * 1000;
let zoneCache: { at: number; zones: { id: string; name: string }[] } | null = null;

/** The zones the instance's Cloudflare token reaches, cached for ten minutes:
 *  every list screen reads it and the account rarely changes. */
async function cloudflareZones(): Promise<{ id: string; name: string }[]> {
    if (zoneCache && Date.now() - zoneCache.at < ZONE_TTL_MS) return zoneCache.zones;
    const zones = await editableZones().catch(() => [] as { id: string; name: string }[]);
    zoneCache = { at: Date.now(), zones };
    return zones;
}

/** Forget the zone list, after the token changed. */
export function forgetZoneCache(): void {
    zoneCache = null;
}

const apexCache = new Map<string, string | null>();

/**
 * The zone a hostname lives in - the closest name above it with an SOA - asked
 * of the public resolvers once per hostname and remembered. Null when nothing
 * answered.
 */
export async function zoneApexOf(hostname: string): Promise<string | null> {
    const name = clean(hostname);
    if (apexCache.has(name)) return apexCache.get(name) ?? null;
    const resolver = publicResolver();
    const labels = name.split(".");
    let apex: string | null = null;
    // From the registrable end upwards would need the public suffix list; from
    // the name downwards needs only the SOA, and stops at the first zone cut.
    for (let start = 0; start < labels.length - 1; start += 1) {
        const candidate = labels.slice(start).join(".");
        const soa = await resolver.resolveSoa(candidate).catch(() => null);
        if (soa) {
            apex = candidate;
            break;
        }
    }
    if (apexCache.size > 2000) apexCache.clear();
    apexCache.set(name, apex);
    return apex;
}

/** DKIM selectors and the SPF a mail server's stored DNS scan names for a domain. */
function mailRecords(
    server: Parameters<typeof storedDns>[0],
    domain: string
): { spf: string | null; selectors: string[] } {
    const report = storedDns(server)?.reports.find((entry) => entry.domain === domain);
    if (!report) return { spf: null, selectors: [] };
    const spf =
        report.records.find((entry) => entry.record.purpose === "spf")?.record.value ?? null;
    const selectors = report.records
        .filter((entry) => entry.record.purpose === "dkim")
        .map((entry) => entry.record.name.split("._domainkey.")[0] ?? "")
        .filter(Boolean);
    return { spf, selectors };
}

interface Draft {
    sources: Set<DomainSource>;
    ownerDomain: KnownDomain["ownerDomain"];
    zone: KnownDomain["zone"];
    mailServers: KnownDomain["mailServers"][number][];
    hostnames: KnownDomain["hostnames"][number][];
}

/**
 * Every domain Polaris knows about, instance-wide. What an administrator sees.
 * With `within`, only that domain and the ones under it are read - all a single
 * domain's entry depends on, since a hostname is filed under the deepest known
 * domain above it.
 */
export async function knownDomains(
    options: { resolveParents?: boolean; within?: string } = {}
): Promise<KnownDomain[]> {
    const within = options.within ? clean(options.within) : null;
    const near = within
        ? [
              { equals: within, mode: "insensitive" as const },
              { endsWith: `.${within}`, mode: "insensitive" as const }
          ]
        : null;
    const drafts = new Map<string, Draft>();
    const draft = (domain: string): Draft => {
        const name = clean(domain);
        let entry = drafts.get(name);
        if (!entry) {
            entry = {
                sources: new Set(),
                ownerDomain: null,
                zone: null,
                mailServers: [],
                hostnames: []
            };
            drafts.set(name, entry);
        }
        return entry;
    };

    const [config, owned, servers, zones, hostnames] = await Promise.all([
        getDomainZones(),
        prisma.ownerDomain.findMany({
            where: {
                verifiedAt: { not: null },
                ...(near ? { OR: near.map((domain) => ({ domain })) } : {})
            },
            select: { id: true, domain: true, userId: true, orgId: true, dnsToken: true }
        }),
        prisma.mailServer.findMany({ where: { status: { in: ["ready", "down"] } } }),
        cloudflareZones(),
        prisma.domain.findMany({
            where: {
                enabled: true,
                kind: { in: ["custom", "base", "random"] },
                ...(near ? { OR: near.map((hostname) => ({ hostname })) } : {})
            },
            select: { hostname: true, applicationId: true, certResolver: true },
            take: 500
        })
    ]);

    if (config.baseDomain && !shared(config.baseDomain))
        draft(config.baseDomain).sources.add("instance");
    for (const zone of zones) {
        const entry = draft(zone.name);
        entry.sources.add("cloudflare");
        entry.zone = { id: zone.id, name: zone.name };
    }
    for (const row of owned) {
        const entry = draft(row.domain);
        entry.sources.add("owner");
        entry.ownerDomain = {
            id: row.id,
            userId: row.userId,
            orgId: row.orgId,
            hasToken: Boolean(row.dnsToken)
        };
    }
    for (const server of servers) {
        const names = new Set([
            server.primaryDomain,
            ...(storedDns(server)?.reports.map((report) => report.domain) ?? [])
        ]);
        for (const name of names) {
            if (!name || shared(clean(name))) continue;
            const entry = draft(name);
            entry.sources.add("mail-server");
            const records = mailRecords(server, clean(name));
            entry.mailServers.push({
                id: server.id,
                ownerId: server.ownerId,
                orgId: server.orgId,
                reports: Boolean(server.reportsSecret),
                spf: records.spf,
                selectors: records.selectors
            });
        }
    }

    // A zone on the account holds every domain under it; the deepest known
    // domain is the one a hostname is filed under.
    const parentOf = (hostname: string): string | null =>
        [...drafts.keys()]
            .filter((domain) => under(hostname, domain))
            .sort((a, b) => b.length - a.length)[0] ?? null;
    for (const row of hostnames) {
        const hostname = clean(row.hostname);
        if (shared(hostname)) continue;
        let parent = parentOf(hostname);
        if (!parent && options.resolveParents) parent = await zoneApexOf(hostname);
        if (!parent) continue;
        const entry = draft(parent);
        entry.sources.add("deploy");
        entry.hostnames.push({
            hostname,
            applicationId: row.applicationId,
            le: row.certResolver === "le"
        });
    }
    // Zones whose domain is under another known one keep their own entry: a
    // delegated subdomain is its own zone with its own records.
    for (const [domain, entry] of drafts) {
        if (!entry.zone) {
            const zone = zones
                .filter((candidate) => under(domain, candidate.name))
                .sort((a, b) => b.name.length - a.name.length)[0];
            if (zone) entry.zone = { id: zone.id, name: zone.name };
        }
    }

    return [...drafts.entries()]
        .filter(
            ([domain]) =>
                domain.includes(".") &&
                !core.isIpAddress(domain) &&
                (!within || under(domain, within))
        )
        .map(([domain, entry]) => ({
            domain,
            sources: [...entry.sources],
            ownerDomain: entry.ownerDomain,
            zone: entry.zone,
            mailServers: entry.mailServers,
            hostnames: entry.hostnames
        }))
        .sort((a, b) => a.domain.localeCompare(b.domain));
}

/** One known domain, or null when Polaris has no reason to know it. */
export async function knownDomain(domain: string): Promise<KnownDomain | null> {
    const name = clean(domain);
    return (await knownDomains({ within: name })).find((entry) => entry.domain === name) ?? null;
}
