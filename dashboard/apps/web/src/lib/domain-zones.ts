/**
 * The operator's domain layout: one base domain plus the zones Polaris mints
 * hostnames under - `*.polaris.<base>` for Polaris's own services and `*.plr.<base>`
 * for deployed ones by default, plus any extra deploy zone the operator adds. Each
 * zone needs exactly one wildcard DNS record, so hostnames scale without touching
 * DNS again, and a zone with an empty label puts everything on the base domain
 * itself (`*.example.com`).
 *
 * Stored as one JSON Setting - this is configuration, not per-resource state, so it
 * needs no table - and validated on every read, so an older or hand-edited value can
 * never produce a malformed hostname.
 */

import { z } from "zod";
import { getSetting, setSetting } from "./setting-store";
import { usableOwnerDomains, type DomainOwner } from "./owner-domains";
import {
    pickZone,
    zoneHost,
    isZoneLabel,
    zoneWildcard,
    defaultZones,
    isBaseDomain,
    zoneHostname,
    namedZoneHostname,
    normalizeZoneName,
    randomZoneHostname,
    normalizeBaseDomain,
    type DomainZone,
    type ZoneScope
} from "@polaris/deploy";

const KEY = "domain.zones";
/** Set once the zones' names have been seen resolving to this server. */
const VERIFIED_KEY = "domain.zones.verified";
/** Set once something on the domain has actually answered over HTTP. */
const REACHABLE_KEY = "domain.zones.reachable";
/** Set while the operator wants the dashboard moved onto the Polaris zone. */
const DASHBOARD_KEY = "domain.zones.dashboard";

const zoneSchema = z.object({
    label: z
        .string()
        .trim()
        .toLowerCase()
        .refine(isZoneLabel, "Use a single label like plr, or leave it empty"),
    scope: z.enum(["polaris", "deploy"]),
    primary: z.boolean().default(false)
});

/** What a caller may submit. The base domain is normalized before it is checked, so
 *  `https://Example.com/` and `*.example.com` are accepted as `example.com`. */
export const domainZoneInputSchema = z.object({
    baseDomain: z
        .string()
        .transform(normalizeBaseDomain)
        .refine((value) => value === "" || isBaseDomain(value), "Enter a domain like example.com"),
    zones: z.array(zoneSchema).max(24)
});

export interface DomainZoneConfig {
    /** Empty when no domain is configured - callers then fall back to free subdomains. */
    baseDomain: string;
    zones: DomainZone[];
}

/**
 * Keep the stored layout self-consistent: no two zones of the same scope on one
 * hostname (they would fight over which is the default), and exactly one primary per
 * scope. Two scopes may share a label - a Polaris zone and a deploy zone both on the
 * base domain is the documented way to put everything on `example.com` - because a
 * single wildcard record serves both, and `zoneRecords` asks for it once.
 */
function reconcile(zones: DomainZone[]): DomainZone[] {
    const seen = new Set<string>();
    const unique = zones.filter((zone) => {
        const key = `${zone.scope}:${zone.label}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
    const scopes: ZoneScope[] = ["polaris", "deploy"];
    return scopes.flatMap((scope) => {
        const scoped = unique.filter((zone) => zone.scope === scope);
        if (scoped.length === 0) return [];
        const primary = scoped.find((zone) => zone.primary) ?? scoped[0];
        return scoped.map((zone) => ({ ...zone, primary: zone === primary }));
    });
}

/** The configured layout, or the defaults when nothing has been saved yet. */
export async function getDomainZones(): Promise<DomainZoneConfig> {
    const raw = await getSetting(KEY);
    if (!raw) return { baseDomain: "", zones: defaultZones() };
    const parsed = domainZoneInputSchema.safeParse(safeJson(raw));
    // A value this version cannot read is treated as unset rather than trusted:
    // a malformed layout would mint hostnames that resolve nowhere.
    if (!parsed.success) return { baseDomain: "", zones: defaultZones() };
    const zones = reconcile(parsed.data.zones);
    return { baseDomain: parsed.data.baseDomain, zones: zones.length > 0 ? zones : defaultZones() };
}

function safeJson(raw: string): unknown {
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

/** Validate and store the layout. Throws a user-safe message on invalid input. */
export async function saveDomainZones(input: unknown): Promise<DomainZoneConfig> {
    const parsed = domainZoneInputSchema.safeParse(input);
    if (!parsed.success)
        throw new Error(parsed.error.issues[0]?.message ?? "Invalid domain configuration");
    const zones = reconcile(parsed.data.zones);
    if (parsed.data.baseDomain && zones.every((zone) => zone.scope !== "deploy")) {
        throw new Error("Keep at least one zone for deployed services");
    }
    const config: DomainZoneConfig = { baseDomain: parsed.data.baseDomain, zones };
    await setSetting(KEY, JSON.stringify(config));
    // A changed layout is unproven again on both counts: the new names have never
    // been seen resolving, let alone answering. Both are re-earned by the next check.
    await setSetting(VERIFIED_KEY, null);
    await setSetting(REACHABLE_KEY, null);
    return config;
}

/**
 * Whether the configured zones have been seen resolving to this server - both the
 * zone host and its wildcard. This is what gates minting a hostname: a zone saved in
 * the wizard is an intention, and a service given a name that resolves nowhere also
 * gets a certificate order that cannot complete.
 */
export async function zoneDnsVerified(): Promise<boolean> {
    return (await getSetting(VERIFIED_KEY)) === "1";
}

/** Record the outcome of a DNS check (see domain-dns). */
export async function setZoneDnsVerified(verified: boolean): Promise<void> {
    await setSetting(VERIFIED_KEY, verified ? "1" : null);
}

/**
 * Whether traffic to the domain has been seen arriving here, which correct DNS does
 * not prove on its own: on a home line the record points at the router, and the ports
 * may never have been forwarded.
 *
 * Kept apart from `zoneDnsVerified` because the probe can only ever confirm, never
 * deny - it runs from this box, and plenty of routers do not loop a request back to
 * their own WAN address. So it gates the two things where being wrong is cheap:
 * standing the fallback tunnel down, and moving the dashboard's own URL. Minting
 * hostnames waits for DNS only, or a domain that works from outside but not from the
 * inside could never publish anything.
 */
export async function zoneReachable(): Promise<boolean> {
    return (await getSetting(REACHABLE_KEY)) === "1";
}

export async function setZoneReachable(reachable: boolean): Promise<void> {
    await setSetting(REACHABLE_KEY, reachable ? "1" : null);
}

/**
 * Whether the operator asked for the dashboard to move onto the Polaris zone. Kept as
 * an intention rather than applied on the spot: the app domain is what every URL
 * Polaris hands out is built from - invites, notification links, the dashboard link
 * itself - so it may only move once the zone has been seen resolving here (see
 * `applyDashboardZone` in domain-dns). Cleared once carried out.
 */
export async function getDashboardZoneIntent(): Promise<boolean> {
    return (await getSetting(DASHBOARD_KEY)) === "1";
}

export async function setDashboardZoneIntent(wanted: boolean): Promise<void> {
    await setSetting(DASHBOARD_KEY, wanted ? "1" : null);
}

/** Every zone as the pair of DNS names it needs, for the setup checklist. */
export interface ZoneRecords {
    zone: DomainZone;
    /** The zone's own hostname (`plr.example.com`). */
    host: string;
    /** The wildcard that covers every hostname Polaris mints in it. */
    wildcard: string;
}

/**
 * The one record a game's servers need, so their names cost no DNS between them.
 *
 * A game server takes a name under its game's label (`survival.mc.example.com`), and
 * until a wildcard covers that label each server has to have a record written for it -
 * which is a zone that fills up at one or two records per server and an operator who
 * cannot run a hundred of them. One wildcard per game replaces all of it.
 *
 * Only the wildcard, unlike a deploy zone: nothing serves `mc.example.com` itself, so
 * asking for a record there would be asking for one nothing would ever answer on.
 */
export interface GameZoneRecords {
    /** The game whose servers take names here, so the checklist can say why. */
    readonly game: string;
    /** The label under the base domain (`mc`). */
    readonly label: string;
    /** The record that covers every server name of this game, present and future. */
    readonly wildcard: string;
}

/** A game as this needs to know it: what it is called, and the label it mints under. */
export interface GameZone {
    readonly name: string;
    readonly domainLabel: string;
}

/**
 * One wildcard per installed game. Pure - the caller supplies the games, so this stays
 * testable and the DB read lives with the code that knows what "installed" means
 * (`lib/apps/game-zones`).
 *
 * Deduplicated by label: two games sharing one would otherwise ask for the same record
 * twice and check it twice.
 */
export function gameZoneRecords(
    config: DomainZoneConfig,
    games: readonly GameZone[]
): GameZoneRecords[] {
    if (!config.baseDomain) return [];
    const seen = new Set<string>();
    return games.flatMap((game) => {
        const label = game.domainLabel.trim().toLowerCase();
        // A game whose label is not a usable DNS label would produce a record nobody
        // could create. Dropped rather than shown: the catalog is ours, so this is a
        // catalog bug, and the checklist is not where to report it.
        if (!isZoneLabel(label) || label === "" || seen.has(label)) return [];
        seen.add(label);
        return [{ game: game.name, label, wildcard: `*.${label}.${config.baseDomain}` }];
    });
}

export function zoneRecords(config: DomainZoneConfig): ZoneRecords[] {
    if (!config.baseDomain) return [];
    // One pair per hostname, not per zone: zones of different scopes may sit on the
    // same label, and one wildcard record answers for both - listing it twice would
    // show the operator the same record to create twice and check it twice.
    const seen = new Set<string>();
    return config.zones.flatMap((zone) => {
        const host = zoneHost(zone, config.baseDomain);
        if (seen.has(host)) return [];
        seen.add(host);
        return [{ zone, host, wildcard: zoneWildcard(zone, config.baseDomain) }];
    });
}

/**
 * The wildcard base deployed services get their hostnames under (`plr.example.com`),
 * or null when no domain is configured. This is what makes the zone layout the single
 * source of truth for the exposure mode's wildcard domain.
 */
export async function deployZoneBase(label?: string): Promise<string | null> {
    const config = await getDomainZones();
    if (!config.baseDomain) return null;
    const zone = pickZone(config.zones, "deploy", label);
    return zone ? zoneHost(zone, config.baseDomain) : null;
}

/**
 * Every zone deployed services get hostnames under that Polaris may answer for as a
 * whole, deduplicated.
 *
 * All of them rather than the primary, because a name in any deploy zone is a name
 * Polaris minted and then stopped serving; and unlike the picker, this is not gated on
 * the zone's DNS being verified - a zone whose records were never checked can still be
 * the one a stale link points at.
 *
 * A zone on the empty label is left out, and that is the whole reason this is not just
 * a map over the deploy zones. Its host is the operator's bare domain, so claiming
 * everything one label under it would claim their mail, their VPN and every other
 * machine on that domain - names Polaris never handed out and has no business
 * answering for. It stays a valid zone to MINT in; it is not one to speak for.
 */
export async function deployZoneHosts(): Promise<string[]> {
    const config = await getDomainZones();
    if (!config.baseDomain) return [];
    const hosts = config.zones
        .filter((zone) => zone.scope === "deploy" && zone.label !== "")
        .map((zone) => zoneHost(zone, config.baseDomain));
    return [...new Set(hosts)];
}

/** The hostname Polaris's own dashboard lives on, or null when no domain is set. */
export async function polarisZoneHost(): Promise<string | null> {
    const config = await getDomainZones();
    if (!config.baseDomain) return null;
    const zone = pickZone(config.zones, "polaris");
    return zone ? zoneHost(zone, config.baseDomain) : null;
}

/**
 * How a zone belonging to the deployer rather than to the operator is named in a
 * picker.
 *
 * The picker passes one string down the whole chain - the action, the service,
 * the mint - and an operator zone is identified by its DNS label. A domain
 * somebody brought has no label under the base domain, so it needs a key of its
 * own that cannot be mistaken for one: `@` is not legal in a DNS label, so
 * `@example.com` can never collide with a zone the operator configured.
 */
const OWNER_ZONE_PREFIX = "@";

export function ownerZoneKey(domain: string): string {
    return `${OWNER_ZONE_PREFIX}${domain}`;
}

/** The domain a picker key names, or null when the key is an operator zone. */
export function ownerZoneDomain(key: string | undefined): string | null {
    if (!key || key === BASE_ZONE_KEY || !key.startsWith(OWNER_ZONE_PREFIX)) return null;
    return key.slice(OWNER_ZONE_PREFIX.length) || null;
}

/**
 * The picker key for a name directly on the operator's base domain.
 *
 * Every zone above stands on one wildcard record, which is what lets Polaris hand
 * out names under it without touching DNS again. Plenty of domains have no
 * wildcard and still want `invoices.example.com`, and that name needs a record of
 * its own - so the base domain is offered as its own entry rather than as a zone,
 * and whoever adds the domain writes the record for the exact hostname it returns.
 *
 * `~` is not legal in a DNS label and is not the owner prefix, so this key can be
 * confused with neither.
 */
export const BASE_ZONE_KEY = "~base";

export function isBaseZoneKey(key: string | undefined): boolean {
    return key === BASE_ZONE_KEY;
}

/**
 * The hostname a base yields for these options: a random label, the subdomain
 * that was picked, or one derived from the service name so a redeploy keeps the
 * URL.
 *
 * "bad-name" when something was typed and no DNS label survives it. Refused
 * rather than quietly replaced by the derived name, or the operator ends up
 * looking at a URL they never asked for.
 */
function mintUnder(
    host: string,
    name: string,
    options: { random?: boolean; subdomain?: string }
): string | "bad-name" {
    const zone = { label: "", scope: "deploy" as const, primary: false };
    if (options.random) return randomZoneHostname(zone, host);
    const picked = normalizeZoneName(options.subdomain ?? "");
    if (picked) return namedZoneHostname(picked, zone, host);
    return options.subdomain?.trim() ? "bad-name" : zoneHostname(name, zone, host);
}

/** Why a hostname could not be minted, so the caller can say which of the two it is
 *  instead of sending the operator back to a setup that is actually fine. */
export type ZoneMintFailure = "no-domain" | "unknown-zone" | "unverified" | "bad-name";

export interface MintedHostname {
    hostname: string;
    /** The zone's own hostname, for finding other names Polaris minted in it. */
    zoneHost: string;
}

/**
 * A hostname for a service inside a deploy zone: the subdomain the operator picked,
 * else deterministic from the name (so a redeploy keeps the URL), or random when the
 * caller wants an unguessable one. A picked subdomain is taken literally - whether
 * anything else already answers on it is the caller's to check, since only it knows
 * which service is asking.
 */
export async function deployHostname(
    name: string,
    options: { zoneLabel?: string; random?: boolean; subdomain?: string; owner?: DomainOwner } = {}
): Promise<MintedHostname | ZoneMintFailure> {
    // A domain the deployer brought themselves is checked against what they
    // actually hold, not against what the picker offered: the key travels through
    // a server action, so it is a claim like any other. `usableOwnerDomains` only
    // returns the ones proven owned AND seen resolving here, which is exactly the
    // pair that makes a minted hostname work.
    const owned = ownerZoneDomain(options.zoneLabel);
    if (owned) {
        if (!options.owner) return "unknown-zone";
        const usable = await usableOwnerDomains(options.owner);
        if (!usable.includes(owned)) return "unverified";
        const minted = mintUnder(owned, name, options);
        return minted === "bad-name" ? minted : { hostname: minted, zoneHost: owned };
    }

    const config = await getDomainZones();
    if (!config.baseDomain) return "no-domain";
    // A name straight on the base domain. Deliberately ahead of the verification
    // gate below: that gate stands for a wildcard record, and this path does not
    // ride one - the caller writes a record for the exact hostname, exactly as it
    // does for a hostname somebody typed in full.
    if (isBaseZoneKey(options.zoneLabel)) {
        const minted = mintUnder(config.baseDomain, name, options);
        return minted === "bad-name" ? minted : { hostname: minted, zoneHost: config.baseDomain };
    }
    // The same gate the picker applies, enforced where the hostname is actually
    // minted: an unproven zone yields a name nobody can reach and an ACME order that
    // cannot complete, however the caller got here.
    if (!(await zoneDnsVerified())) return "unverified";
    const zone = pickZone(config.zones, "deploy", options.zoneLabel);
    if (!zone) return "unknown-zone";
    const host = zoneHost(zone, config.baseDomain);
    const minted = mintUnder(host, name, options);
    return minted === "bad-name" ? minted : { hostname: minted, zoneHost: host };
}

/**
 * Where a hostname would come from. `zone` and `owned` both ride a wildcard
 * record and need no DNS work; `base` is one record per name, so a picker has to
 * say so and the caller has to write it.
 */
export type DeployZoneKind = "zone" | "owned" | "base";

export interface DeployZoneOption {
    /** What a picker sends back, and what `deployHostname` reads. */
    readonly label: string;
    readonly host: string;
    readonly primary: boolean;
    readonly kind: DeployZoneKind;
}

/**
 * The deploy zones offered in a picker: the operator's, then any this deployer
 * brought themselves.
 *
 * `primary` marks the layout's default, so a picker preselects the same zone the
 * server would have chosen on its own. An owner's domain is never the default -
 * it is offered, not assumed, because which name a service should answer on is a
 * decision and picking one silently is how a client's service ends up published
 * on somebody's personal domain.
 */
export async function listDeployZones(owner?: DomainOwner): Promise<DeployZoneOption[]> {
    const config = await getDomainZones();
    // Unproven zones are not offered: this is the picker's default, so a service added
    // right after the wizard would otherwise take a hostname that resolves nowhere and
    // ask Let's Encrypt to certify it, retrying until the records exist.
    const operator: DeployZoneOption[] =
        config.baseDomain && (await zoneDnsVerified())
            ? config.zones
                  .filter((zone) => zone.scope === "deploy")
                  .map((zone) => ({
                      label: zone.label,
                      host: zoneHost(zone, config.baseDomain),
                      primary: zone.primary,
                      kind: "zone" as const
                  }))
            : [];

    // The base domain on its own, unless a zone already sits on it. Offered even
    // with no proven zone, because this one does not stand on a wildcard: the
    // record for the exact hostname is written when the domain is added, so there
    // is nothing here to have verified first.
    const base: DeployZoneOption[] =
        config.baseDomain && !operator.some((zone) => zone.host === config.baseDomain)
            ? [{ label: BASE_ZONE_KEY, host: config.baseDomain, primary: false, kind: "base" }]
            : [];

    if (!owner) return [...operator, ...base];
    const brought: DeployZoneOption[] = (await usableOwnerDomains(owner)).map((domain) => ({
        label: ownerZoneKey(domain),
        host: domain,
        primary: false,
        kind: "owned"
    }));
    return [...operator, ...base, ...brought];
}
