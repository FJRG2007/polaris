/**
 * Address intelligence: deciding who the edge blocks on sight, and publishing that
 * decision to it.
 *
 * Three sources feed one list. Jails ban an address for what it did (see
 * waf-ban-service). Feeds are bulk lists Polaris fetches - the Tor exit list today.
 * Reputation providers are asked about addresses that actually show up in traffic,
 * and their verdicts are cached as ordinary bans.
 *
 * All three converge on a snapshot file the edge guard mounts read-only and holds in
 * memory. Nothing here is on the request path: a provider being slow, a feed being
 * unreachable, or Polaris being down entirely cannot delay or unblock a single
 * request - the guard keeps enforcing the last snapshot it read.
 */

import { prisma } from "@polaris/db";
import { dirname, join } from "node:path";
import { verifyIp } from "@/lib/integrations/dymo";
import { EDGE_TOKEN_TTL_SECONDS } from "@polaris/core/waf";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readDymoConfig } from "@/lib/integrations/registry";
import { getIntegrationSecret, getIntegrationState } from "@/lib/integration-service";
import { checkCriminalIp, readCriminalIpConfig } from "@/lib/integrations/criminalip";
import { buildWafIntel, type WafIntelEntry, type WafIntelReason } from "@polaris/core";

/** Where the snapshot is written. Mounted read-only into the edge guard as
 *  POLARIS_EDGE_INTEL_FILE. Kept out of Traefik's own dynamic directory on purpose:
 *  the file provider there parses every .json it finds and would log this one as a
 *  broken route config. */
function snapshotPath(): string {
    return process.env.POLARIS_EDGE_INTEL_FILE ?? "/edge-intel/waf-intel.json";
}

/** The Tor exit list, which is the one feed shipped today. Public, unauthenticated,
 *  one address per line. */
const TOR_FEED_ID = "tor";
const TOR_EXIT_LIST_URL = "https://check.torproject.org/torbulkexitlist";

/** How long a fetched feed is trusted before a refresh is attempted. Tor exits turn
 *  over on the order of hours, so this is frequent enough to matter and rare enough
 *  to be a non-event. */
const FEED_TTL_MS = 60 * 60 * 1000;

/** Reputation verdicts are cached as bans with this lifetime; an address that is
 *  still bad will be asked about again after it lapses. */
const REPUTATION_TTL_MS = 6 * 60 * 60 * 1000;

/** Never ask a provider about an address that cannot be reached from outside. */
function routable(ip: string): boolean {
    return !(
        ip.startsWith("10.") ||
        ip.startsWith("192.168.") ||
        ip.startsWith("127.") ||
        ip.startsWith("169.254.") ||
        ip === "::1" ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    );
}

/** Whether a feed is switched on, and the addresses it last returned. */
export async function getWafFeed(id: string) {
    return prisma.wafIpFeed.findUnique({ where: { id } });
}

/**
 * Whether a feed is enforced, given its row or the absence of one.
 *
 * Absence means on. Nothing legitimate reaches a home server from a Tor exit node, and
 * a protection that only exists once somebody finds the switch protects the people who
 * were already looking. An operator who wants Tor traffic turns it off and the row
 * records that, which is why absence can safely be read as the default rather than as
 * "never decided".
 */
export function wafFeedEnabled(feed: { readonly enabled: boolean } | null): boolean {
    return feed?.enabled ?? true;
}

/** Turn a feed on or off. Turning it on refreshes immediately so the operator sees
 *  a count rather than an empty list they have to wait out. */
export async function setWafFeedEnabled(id: string, enabled: boolean): Promise<void> {
    await prisma.wafIpFeed.upsert({
        where: { id },
        create: { id, enabled },
        update: { enabled }
    });
    if (enabled) await refreshWafFeeds(true);
    await publishWafIntel();
}

/**
 * Refresh every enabled feed whose copy has aged out. A failure is recorded on the
 * row and the previous list is kept: an unreachable torproject.org must not silently
 * unblock every exit node.
 */
export async function refreshWafFeeds(force = false): Promise<void> {
    const feed = await prisma.wafIpFeed.findUnique({ where: { id: TOR_FEED_ID } });
    if (!wafFeedEnabled(feed)) return;
    const age = feed?.fetchedAt ? Date.now() - feed.fetchedAt.getTime() : Infinity;
    if (!force && age < FEED_TTL_MS) return;
    try {
        const response = await fetch(TOR_EXIT_LIST_URL, {
            signal: AbortSignal.timeout(20_000),
            headers: { accept: "text/plain" }
        });
        if (!response.ok) throw new Error(`the exit list responded ${response.status}`);
        const entries = (await response.text())
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line !== "" && !line.startsWith("#"));
        if (entries.length === 0) throw new Error("the exit list came back empty");
        // Upserted rather than updated: the feed is on before anyone has saved a row
        // for it, so the first successful fetch is what creates one.
        const fetched = { entries: JSON.stringify(entries), fetchedAt: new Date(), error: null };
        await prisma.wafIpFeed.upsert({
            where: { id: TOR_FEED_ID },
            create: { id: TOR_FEED_ID, enabled: true, ...fetched },
            update: fetched
        });
    } catch (caught) {
        const message = caught instanceof Error ? caught.message : "the refresh failed";
        await prisma.wafIpFeed.upsert({
            where: { id: TOR_FEED_ID },
            create: { id: TOR_FEED_ID, enabled: true, error: message },
            update: { error: message }
        });
    }
}

/** One reputation provider, reduced to the only thing the firewall needs from it. */
interface ReputationProvider {
    readonly slug: string;
    check(ip: string): Promise<{ allow: boolean; reasons: string[] }>;
}

/** The providers the operator has connected and switched on, in the order they are
 *  asked. An empty list means reputation is simply not part of the firewall. */
async function reputationProviders(): Promise<ReputationProvider[]> {
    const providers: ReputationProvider[] = [];

    const dymo = await getIntegrationState("dymo");
    if (dymo?.enabled) {
        const config = readDymoConfig(dymo.config);
        const apiKey = await getIntegrationSecret("dymo");
        if (apiKey && config.deny.length > 0) {
            providers.push({ slug: "dymo", check: (ip) => verifyIp(apiKey, ip, config.deny) });
        }
    }

    const criminalIp = await getIntegrationState("criminalip");
    if (criminalIp?.enabled) {
        const config = readCriminalIpConfig(criminalIp.config);
        const apiKey = await getIntegrationSecret("criminalip");
        if (apiKey && config.deny.length > 0) {
            providers.push({ slug: "criminalip", check: (ip) => checkCriminalIp(apiKey, ip, config.deny) });
        }
    }

    return providers;
}

/**
 * Ask the configured reputation providers about addresses seen in traffic, and
 * record a ban for the ones they flag.
 *
 * Only addresses that are new to us are asked about, and only a bounded number per
 * pass, because a provider charges per lookup and a traffic spike must not turn into
 * a bill. The first provider to flag an address ends the question for it. Failures
 * are ignored entirely: not knowing whether an address is bad is the same as not
 * blocking it, which is the only safe direction for something that runs unattended.
 */
export async function checkReputation(ips: readonly string[]): Promise<void> {
    const providers = await reputationProviders();
    if (providers.length === 0) return;

    const candidates = [...new Set(ips.filter(routable))];
    if (candidates.length === 0) return;
    const known = new Set(
        (await prisma.wafBan.findMany({ where: { ip: { in: candidates } }, select: { ip: true } })).map(
            (row) => row.ip
        )
    );
    const unknown = candidates.filter((ip) => !known.has(ip)).slice(0, REPUTATION_BATCH);
    for (const ip of unknown) {
        for (const provider of providers) {
            try {
                const { allow, reasons } = await provider.check(ip);
                if (allow) continue;
                await recordWafBan({
                    ip,
                    reason: "reputation",
                    source: provider.slug,
                    note: reasons[0] ?? "flagged",
                    until: new Date(Date.now() + REPUTATION_TTL_MS)
                });
                break;
            } catch {
                // A provider that cannot answer does not get to block anyone, and does
                // not stop the next one from being asked.
            }
        }
    }
}

/** Lookups per pass. A provider is billed per call and a spike must not become a
 *  bill; anything not asked about this time is asked about next time. */
const REPUTATION_BATCH = 25;

export interface WafBanInput {
    readonly ip: string;
    readonly reason: WafIntelReason;
    readonly source: string;
    readonly note?: string;
    /** Null for an entry that stands until it is removed by hand. */
    readonly until: Date | null;
}

/**
 * Record a ban, counting it as a repeat if the address has been here before. The
 * offence count is what makes the next ban longer, so it is kept even after a ban
 * lapses - the row stays, holding an expiry in the past, until it is pruned.
 */
export async function recordWafBan(input: WafBanInput): Promise<void> {
    const existing = await prisma.wafBan.findUnique({ where: { ip: input.ip }, select: { until: true, offences: true } });
    // A ban that is still running is extended, not re-counted: one jail firing twice
    // inside its own window is one offence, not two. A permanent ban is always still
    // running - without that, re-detecting it on every pass would count an offence
    // every thirty seconds for as long as the evidence stayed in the log window.
    const stillRunning = existing !== null && (existing.until === null || existing.until > new Date());
    const offences = existing ? existing.offences + (stillRunning ? 0 : 1) : 1;
    await prisma.wafBan.upsert({
        where: { ip: input.ip },
        create: {
            ip: input.ip,
            reason: input.reason,
            source: input.source,
            note: input.note ?? null,
            until: input.until
        },
        update: { reason: input.reason, source: input.source, note: input.note ?? null, until: input.until, offences }
    });
}

/** Lift a ban by hand. */
export async function removeWafBan(ip: string): Promise<void> {
    await prisma.wafBan.deleteMany({ where: { ip } });
    await publishWafIntel();
}

/** Active bans, newest first, for the firewall page. */
export async function listWafBans(limit = 100) {
    return prisma.wafBan.findMany({
        where: { OR: [{ until: null }, { until: { gt: new Date() } }] },
        orderBy: { updatedAt: "desc" },
        take: limit
    });
}

/** How many times each of these addresses has been banned before. */
export async function priorBanCounts(ips: readonly string[]): Promise<Record<string, number>> {
    if (ips.length === 0) return {};
    const rows = await prisma.wafBan.findMany({
        where: { ip: { in: [...new Set(ips)] } },
        select: { ip: true, offences: true }
    });
    return Object.fromEntries(rows.map((row) => [row.ip, row.offences]));
}

/** Drop rows for bans that lapsed long enough ago that their offence history no
 *  longer says anything useful. */
const HISTORY_RETENTION_MS = 30 * 24 * 3600 * 1000;

export async function pruneWafBans(): Promise<void> {
    await prisma.wafBan.deleteMany({
        where: { until: { lt: new Date(Date.now() - HISTORY_RETENTION_MS) } }
    });
}

/**
 * Write the snapshot the edge reads.
 *
 * Written to a temporary name and renamed into place, because the guard may read the
 * file at any moment and a half-written one would parse as garbage. Rename is atomic
 * on the same filesystem, so the guard sees either the old snapshot or the new one.
 */
export async function publishWafIntel(): Promise<void> {
    const now = Date.now();
    const entries: [string, WafIntelEntry][] = [];

    const bans = await prisma.wafBan.findMany({
        where: { OR: [{ until: null }, { until: { gt: new Date(now) } }] },
        select: { ip: true, reason: true, note: true, until: true }
    });
    for (const ban of bans) {
        entries.push([
            ban.ip,
            {
                reason: (ban.reason as WafIntelReason) ?? "ban",
                until: ban.until ? ban.until.getTime() : null,
                ...(ban.note ? { note: ban.note } : {})
            }
        ]);
    }

    const feed = await prisma.wafIpFeed.findUnique({ where: { id: TOR_FEED_ID } });
    if (feed && wafFeedEnabled(feed)) {
        for (const ip of parseEntries(feed.entries)) {
            // A jail ban says more than "this is a Tor exit", so it wins the slot.
            entries.push([ip, { reason: "tor", until: null }]);
        }
    }

    // Accounts Polaris has re-decided recently enough that a live edge token could
    // still be asserting the old answer: membership moved, banned, sessions revoked.
    // Bounded by the token lifetime rather than kept - an older stamp can only concern
    // tokens that have already expired, and this file is read on the hot path.
    const movedSince = new Date(now - EDGE_TOKEN_TTL_SECONDS * 1000);
    const moved = await prisma.user.findMany({
        where: { principalsMovedAt: { gt: movedSince } },
        select: { id: true, principalsMovedAt: true }
    });

    // Later entries overwrite earlier ones in buildWafIntel's map, so bans are added
    // after the feed rather than before it.
    const snapshot = buildWafIntel(
        [...entries].reverse(),
        now,
        moved.map((user) => [user.id, user.principalsMovedAt?.getTime() ?? 0] as const)
    );
    const path = snapshotPath();
    try {
        await mkdir(dirname(path), { recursive: true });
        const temporary = join(dirname(path), `.waf-intel.${process.pid}.tmp`);
        await writeFile(temporary, JSON.stringify(snapshot), "utf8");
        await rename(temporary, path);
    } catch (caught) {
        console.error(
            "polaris: publishing the firewall's address list failed:",
            caught instanceof Error ? caught.message : caught
        );
    }
}

function parseEntries(json: string): string[] {
    try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
    } catch {
        return [];
    }
}
