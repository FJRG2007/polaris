/**
 * Which records in a zone Polaris wrote, and what each one is there for, so the
 * records screen can mark them and warn before one is changed or deleted.
 *
 * Ownership is read from Polaris's own data, never guessed from a name's shape:
 *
 * - `game-server`: a `GameDnsRecord` row names the record by its Cloudflare id
 *   (the A record a server's name needed, and a Java server's SRV record).
 * - `tunnel`: a deployed service's managed Cloudflare tunnel keeps the id of the
 *   CNAME it wrote (`deploy.ntunnel.<app>.managed`).
 * - `deploy-service`: a deployed service's domain (`Domain.hostname`) is the
 *   record's name.
 * - `dashboard` / `deploy-zone`: the zone layout's own hosts and wildcards
 *   (`plr.<base>`, `*.plr.<base>`, `polaris.<base>`...), by the zone's scope.
 * - `game-zone`: the wildcard an installed game's servers take names under
 *   (`*.mc.<base>`).
 * - `verification`: the `_polaris.<domain>` TXT record an owner domain is proven
 *   with, only when its value is that domain's own token.
 * - `owner-domain`: the wildcard of a proven owner domain.
 *
 * Every lookup is one query for the whole listing, whatever its size.
 */

import { prisma } from "@polaris/db";
import { installedGames } from "@/lib/apps/game-zones";
import { OWNER_DOMAIN_TXT_LABEL } from "@/lib/owner-domains";
import { getDomainZones, gameZoneRecords, zoneRecords } from "@/lib/domain-zones";

export type RecordOwnerKind =
    | "dashboard"
    | "deploy-zone"
    | "deploy-service"
    | "tunnel"
    | "game-zone"
    | "game-server"
    | "verification"
    | "owner-domain";

export interface RecordOwner {
    readonly kind: RecordOwnerKind;
    /** What it serves: a service's or server's name, a game, a domain. */
    readonly label: string;
    /** Where that thing is in Polaris, or null when there is no page for it. */
    readonly href: string | null;
}

/** The parts of a record ownership is decided from. */
export interface OwnedRecordInput {
    readonly id: string;
    readonly type: string;
    readonly name: string;
    readonly content: string;
}

/** What Polaris knows it wrote, keyed the way records are matched against it. */
export interface OwnershipFacts {
    /** By Cloudflare record id: the records Polaris stored the id of. */
    readonly byRecordId: ReadonlyMap<string, RecordOwner>;
    /** By full name: names Polaris points at itself (A, AAAA or CNAME). */
    readonly byHostname: ReadonlyMap<string, RecordOwner>;
    /** By `_polaris.<domain>`: the token the TXT value must equal, and its owner. */
    readonly verification: ReadonlyMap<string, { readonly token: string; readonly owner: RecordOwner }>;
}

/** The types a hostname is pointed at a server with. */
const ADDRESS_TYPES = new Set(["A", "AAAA", "CNAME"]);

function lower(name: string): string {
    return name.trim().toLowerCase().replace(/\.$/, "");
}

/** A TXT value without the quotes Cloudflare may answer it in. */
function txtValue(content: string): string {
    return content.trim().replace(/^"|"$/g, "");
}

/** The owner of one record, or null for one Polaris did not write. Pure. */
export function ownerOf(record: OwnedRecordInput, facts: OwnershipFacts): RecordOwner | null {
    const byId = facts.byRecordId.get(record.id);
    if (byId) return byId;
    const name = lower(record.name);
    if (record.type === "TXT") {
        const proof = facts.verification.get(name);
        return proof && txtValue(record.content) === proof.token ? proof.owner : null;
    }
    if (!ADDRESS_TYPES.has(record.type)) return null;
    return facts.byHostname.get(name) ?? null;
}

/** Each record with its owner, when Polaris has one for it. Pure. */
export function withOwners<R extends OwnedRecordInput>(
    records: readonly R[],
    facts: OwnershipFacts
): (R & { owner?: RecordOwner })[] {
    return records.map((record) => {
        const owner = ownerOf(record, facts);
        return owner ? { ...record, owner } : record;
    });
}

const DOMAINS_PAGE = "/admin/domains";
const TUNNEL_KEY = /^deploy\.ntunnel\.([0-9a-f-]{36})\.managed$/;

function serviceHref(app: { id: string; environment: { projectId: string } }): string {
    return `/apps/deploy/${app.environment.projectId}?service=${encodeURIComponent(app.id)}`;
}

/** The records Polaris keeps a tunnel CNAME id for, by record id, with their app. */
function tunnelRefs(rows: readonly { key: string; value: string }[], zoneId: string) {
    const refs = new Map<string, string>();
    for (const row of rows) {
        const appId = TUNNEL_KEY.exec(row.key)?.[1];
        if (!appId) continue;
        try {
            const parsed = JSON.parse(row.value) as { dnsId?: unknown; zoneId?: unknown };
            if (typeof parsed?.dnsId === "string" && parsed.zoneId === zoneId) refs.set(parsed.dnsId, appId);
        } catch {
            // A value Polaris did not write in this shape claims nothing.
        }
    }
    return refs;
}

/**
 * Everything Polaris knows it wrote in this zone, read in one query per source
 * for the whole listing.
 */
export async function loadOwnershipFacts(
    zoneId: string,
    records: readonly OwnedRecordInput[]
): Promise<OwnershipFacts> {
    const ids = records.map((record) => record.id);
    const names = [...new Set(records.map((record) => lower(record.name)))];
    const plainNames = names.filter((name) => !name.startsWith("*."));
    const proofDomains = names
        .filter((name) => name.startsWith(`${OWNER_DOMAIN_TXT_LABEL}.`))
        .map((name) => name.slice(OWNER_DOMAIN_TXT_LABEL.length + 1));
    const wildcardDomains = names.filter((name) => name.startsWith("*.")).map((name) => name.slice(2));

    const [config, games, gameRecords, domains, tunnelRows, ownerDomains] = await Promise.all([
        getDomainZones(),
        installedGames().catch(() => []),
        ids.length
            ? prisma.gameDnsRecord.findMany({
                  where: { zoneId, recordId: { in: ids }, releaseRequestedAt: null },
                  select: { recordId: true, installedAppId: true, type: true }
              })
            : [],
        plainNames.length
            ? prisma.domain.findMany({
                  where: { hostname: { in: plainNames } },
                  select: {
                      hostname: true,
                      application: { select: { id: true, name: true, environment: { select: { projectId: true } } } }
                  }
              })
            : [],
        prisma.setting.findMany({
            where: { key: { startsWith: "deploy.ntunnel.", endsWith: ".managed" } },
            select: { key: true, value: true }
        }),
        proofDomains.length || wildcardDomains.length
            ? prisma.ownerDomain.findMany({
                  where: { domain: { in: [...proofDomains, ...wildcardDomains] } },
                  select: { domain: true, verifyToken: true, verifiedAt: true }
              })
            : []
    ]);

    const tunnels = tunnelRefs(tunnelRows, zoneId);
    const listed = new Set(ids);
    const tunnelApps = [...tunnels].filter(([recordId]) => listed.has(recordId)).map(([, appId]) => appId);
    const [servers, apps] = await Promise.all([
        gameRecords.length
            ? prisma.installedApp.findMany({
                  where: { id: { in: [...new Set(gameRecords.map((row) => row.installedAppId))] } },
                  select: { id: true, name: true }
              })
            : [],
        tunnelApps.length
            ? prisma.application.findMany({
                  where: { id: { in: [...new Set(tunnelApps)] } },
                  select: { id: true, name: true, environment: { select: { projectId: true } } }
              })
            : []
    ]);

    const byRecordId = new Map<string, RecordOwner>();
    const serverNames = new Map(servers.map((server) => [server.id, server.name]));
    for (const row of gameRecords) {
        const label = serverNames.get(row.installedAppId);
        if (label === undefined) continue;
        byRecordId.set(row.recordId, { kind: "game-server", label, href: `/apps/installed/${row.installedAppId}` });
    }
    const appsById = new Map(apps.map((app) => [app.id, app]));
    for (const [recordId, appId] of tunnels) {
        const app = appsById.get(appId);
        if (app) byRecordId.set(recordId, { kind: "tunnel", label: app.name, href: serviceHref(app) });
    }

    const byHostname = new Map<string, RecordOwner>();
    // Broadest first, so the more specific owner of a name is the one that stays.
    for (const proven of ownerDomains) {
        if (proven.verifiedAt && wildcardDomains.includes(proven.domain))
            byHostname.set(`*.${proven.domain}`, { kind: "owner-domain", label: proven.domain, href: null });
    }
    for (const game of gameZoneRecords(config, games)) {
        byHostname.set(lower(game.wildcard), { kind: "game-zone", label: game.game, href: DOMAINS_PAGE });
    }
    for (const zone of zoneRecords(config)) {
        const owner: RecordOwner =
            zone.zone.scope === "polaris"
                ? { kind: "dashboard", label: zone.host, href: DOMAINS_PAGE }
                : { kind: "deploy-zone", label: zone.host, href: DOMAINS_PAGE };
        byHostname.set(lower(zone.host), owner);
        byHostname.set(lower(zone.wildcard), owner);
    }
    for (const domain of domains) {
        byHostname.set(lower(domain.hostname), {
            kind: "deploy-service",
            label: domain.application.name,
            href: serviceHref(domain.application)
        });
    }

    const verification = new Map<string, { token: string; owner: RecordOwner }>();
    for (const proven of ownerDomains) {
        if (!proofDomains.includes(proven.domain)) continue;
        verification.set(`${OWNER_DOMAIN_TXT_LABEL}.${proven.domain}`, {
            token: proven.verifyToken,
            owner: { kind: "verification", label: proven.domain, href: null }
        });
    }
    return { byRecordId, byHostname, verification };
}
