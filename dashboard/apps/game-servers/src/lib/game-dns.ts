/**
 * The DNS records Polaris writes for game servers, and taking them away again.
 *
 * Creating a server can write two records at the operator's provider: an A record
 * for its name when no wildcard already covers it, and for Minecraft: Java the SRV
 * record that carries its port. Each is remembered by the provider's own id, so
 * deleting or renaming the server removes exactly those and never a record
 * somebody else made.
 *
 * Removing one is best effort for whoever is waiting: a provider that does not
 * answer must not stop a server from being deleted. The record is marked to go
 * instead, the games list says it is still there, and the hourly sweep tries it
 * again until it is gone.
 *
 * The sweep also finds the SRV records written before any of this was kept: a
 * `_minecraft._tcp.<name>.mc.<domain>` record pointing at its own name is the
 * exact shape Polaris writes and nothing else does, so one whose name no live
 * server holds is a leftover of a deleted one.
 */

import { prisma } from "@polaris/db";
import { host } from "@polaris/app-host";

const { getDomainZones } = host.domainZones;
const { loadCloudflareToken } = host.integrationsCloudflareAccountService;
const { deleteDnsRecordIfPresent, listSrvRecordsPage, resolveZoneForHostname } =
    host.integrationsCloudflareApi;

/** What `releaseError` holds when nothing could be tried because no token is
 *  connected, so a screen can say that rather than a provider's sentence. */
export const NO_TOKEN = "no-token";

/** The prefix a Minecraft: Java client looks a server's port up under. */
export const MINECRAFT_SRV_PREFIX = "_minecraft._tcp.";

/** How many records one pass of the sweep settles, and how many pages of a zone
 *  it reads, so a fleet of any size is worked through a bounded slice at a time. */
const SWEEP_BATCH = 200;
const SWEEP_PAGES = 20;

/** The longest provider sentence kept, so a row never grows with an error. */
const ERROR_LENGTH = 300;

export interface GameDnsRecordInput {
    readonly ownerId: string;
    readonly installedAppId: string;
    readonly zoneId: string;
    readonly recordId: string;
    readonly type: "A" | "SRV";
    readonly name: string;
}

/** Remember a record written for a server. Idempotent: writing the same record
 *  again (an upsert that found it) takes it back from whatever was releasing it. */
export async function rememberGameDnsRecord(input: GameDnsRecordInput): Promise<void> {
    const name = input.name.toLowerCase();
    await prisma.gameDnsRecord.upsert({
        where: { zoneId_recordId: { zoneId: input.zoneId, recordId: input.recordId } },
        create: { ...input, name },
        update: {
            ownerId: input.ownerId,
            installedAppId: input.installedAppId,
            type: input.type,
            name,
            releaseRequestedAt: null,
            releaseError: null
        }
    });
}

interface ReleaseRow {
    readonly id: string;
    readonly zoneId: string;
    readonly recordId: string;
}

/** What one round of removals came to. */
export interface ReleaseOutcome {
    readonly released: number;
    readonly failed: number;
}

/**
 * Remove the records written for one server, except the names still in use.
 *
 * Marked first and removed after, so a crash in between leaves rows the sweep
 * picks up rather than records nobody remembers. Never throws: a removal that
 * fails stays marked, with the reason, for the sweep and for the games list.
 */
export async function releaseGameDns(
    installedAppId: string,
    keepNames: readonly string[] = []
): Promise<ReleaseOutcome> {
    const keep = keepNames.map((name) => name.toLowerCase());
    const where = { installedAppId, ...(keep.length > 0 ? { name: { notIn: keep } } : {}) };
    try {
        await prisma.gameDnsRecord.updateMany({
            where: { ...where, releaseRequestedAt: null },
            data: { releaseRequestedAt: new Date() }
        });
        const rows = await prisma.gameDnsRecord.findMany({
            where: { ...where, releaseRequestedAt: { not: null } },
            select: { id: true, zoneId: true, recordId: true },
            take: SWEEP_BATCH
        });
        return await settle(rows);
    } catch (caught) {
        console.error("polaris: game server DNS release failed:", caught);
        return { released: 0, failed: 0 };
    }
}

/** Try to remove each marked record: gone (or already gone) drops the row, anything
 *  else writes down why and leaves it for the next pass. */
async function settle(rows: readonly ReleaseRow[]): Promise<ReleaseOutcome> {
    if (rows.length === 0) return { released: 0, failed: 0 };
    const token = await loadCloudflareToken().catch(() => null);
    if (!token) {
        await prisma.gameDnsRecord.updateMany({
            where: { id: { in: rows.map((row) => row.id) } },
            data: { releaseError: NO_TOKEN }
        });
        return { released: 0, failed: rows.length };
    }
    let released = 0;
    let failed = 0;
    for (const row of rows) {
        try {
            await deleteDnsRecordIfPresent(token, row.zoneId, row.recordId);
            await prisma.gameDnsRecord.deleteMany({ where: { id: row.id } });
            released += 1;
        } catch (caught) {
            failed += 1;
            const reason = caught instanceof Error && caught.message ? caught.message : "unknown";
            await prisma.gameDnsRecord
                .updateMany({
                    where: { id: row.id },
                    data: { releaseError: reason.slice(0, ERROR_LENGTH) }
                })
                .catch(() => undefined);
        }
    }
    return { released, failed };
}

/** The records this owner's deleted servers left behind that could not be removed
 *  yet, for the games list to say so. */
export async function gameDnsLeftovers(
    ownerId: string
): Promise<{ count: number; reason: string | null }> {
    const where = { ownerId, releaseRequestedAt: { not: null }, releaseError: { not: null } };
    const [count, latest] = await Promise.all([
        prisma.gameDnsRecord.count({ where }),
        prisma.gameDnsRecord.findFirst({
            where,
            orderBy: { releaseRequestedAt: "desc" },
            select: { releaseError: true }
        })
    ]);
    return { count, reason: latest?.releaseError ?? null };
}

/** Try this owner's leftovers again now, for the button beside that notice. */
export async function retryGameDnsLeftovers(ownerId: string): Promise<ReleaseOutcome> {
    const rows = await prisma.gameDnsRecord.findMany({
        where: { ownerId, releaseRequestedAt: { not: null } },
        select: { id: true, zoneId: true, recordId: true },
        orderBy: { releaseRequestedAt: "asc" },
        take: SWEEP_BATCH
    });
    return settle(rows);
}

/** Whether a SRV record is one Polaris wrote for a game server under this domain:
 *  `_minecraft._tcp.<one label>.mc.<domain>`, pointing at that same name. Pure. */
export function legacyGameSrvHostname(
    record: { name: string; target: string },
    baseDomain: string
): string | null {
    const name = record.name.toLowerCase();
    if (!name.startsWith(MINECRAFT_SRV_PREFIX)) return null;
    const hostname = name.slice(MINECRAFT_SRV_PREFIX.length);
    const suffix = `.mc.${baseDomain.toLowerCase()}`;
    if (!hostname.endsWith(suffix)) return null;
    const label = hostname.slice(0, -suffix.length);
    if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)) return null;
    return record.target.toLowerCase().replace(/\.$/, "") === hostname ? hostname : null;
}

/** The hostnames among these that a live server still holds. */
async function liveHostnames(hostnames: readonly string[]): Promise<Set<string>> {
    if (hostnames.length === 0) return new Set();
    const rows = await prisma.installedApp.findMany({
        where: {
            status: { not: "removed" },
            OR: hostnames.map((hostname) => ({ config: { contains: hostname } }))
        },
        select: { config: true }
    });
    const wanted = new Set(hostnames);
    const live = new Set<string>();
    for (const row of rows) {
        try {
            const value = (JSON.parse(row.config) as { hostname?: unknown }).hostname;
            if (typeof value === "string" && wanted.has(value.toLowerCase()))
                live.add(value.toLowerCase());
        } catch {
            // A config that does not parse names nothing.
        }
    }
    return live;
}

/** Records of servers that are gone - deleted, or never finished deleting - whose
 *  removal was never asked for: a crash between the delete and the release. */
async function unmarkedOrphans(): Promise<string[]> {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
        SELECT r."id" FROM "GameDnsRecord" r
        LEFT JOIN "InstalledApp" i ON i."id" = r."installedAppId"
        WHERE r."releaseRequestedAt" IS NULL AND (i."id" IS NULL OR i."status" = 'removed')
        LIMIT ${SWEEP_BATCH}`;
    return rows.map((row) => row.id);
}

/** What one sweep did, for the job log. */
export interface GameDnsSweep {
    readonly released: number;
    readonly failed: number;
    readonly legacyRemoved: number;
}

/**
 * The hourly pass: retry what failed, release what a crash forgot, and remove the
 * SRV records deleted servers left behind before any of them were remembered.
 */
export async function sweepGameDns(): Promise<GameDnsSweep> {
    const orphans = await unmarkedOrphans();
    if (orphans.length > 0) {
        await prisma.gameDnsRecord.updateMany({
            where: { id: { in: orphans }, releaseRequestedAt: null },
            data: { releaseRequestedAt: new Date() }
        });
    }
    const due = await prisma.gameDnsRecord.findMany({
        where: { releaseRequestedAt: { not: null } },
        select: { id: true, zoneId: true, recordId: true },
        orderBy: { releaseRequestedAt: "asc" },
        take: SWEEP_BATCH
    });
    const outcome = await settle(due);
    const legacyRemoved = await sweepLegacySrv().catch((caught: unknown) => {
        console.error("polaris: game server DNS sweep could not read the zone:", caught);
        return 0;
    });
    return { ...outcome, legacyRemoved };
}

/**
 * Remove `_minecraft._tcp.<name>.mc.<domain>` records that point at their own name
 * when no live server holds that name and no row remembers them - the shape of
 * every record a deleted server left before records were remembered. Reads the
 * zone a page at a time and stops after a bounded number of pages.
 */
export async function sweepLegacySrv(): Promise<number> {
    const { baseDomain } = await getDomainZones();
    if (!baseDomain) return 0;
    const token = await loadCloudflareToken();
    if (!token) return 0;
    const base = baseDomain.toLowerCase();
    const zone = await resolveZoneForHostname(token, `mc.${base}`);
    let removed = 0;
    let page = 1;
    // Counted in reads rather than pages, so a page read again cannot loop forever.
    for (let reads = 0; reads < SWEEP_PAGES; reads += 1) {
        const { records, more } = await listSrvRecordsPage(
            token,
            zone.id,
            { startsWith: MINECRAFT_SRV_PREFIX, endsWith: `.mc.${base}` },
            page
        );
        const candidates = records.flatMap((record) => {
            const hostname = legacyGameSrvHostname(record, base);
            return hostname ? [{ id: record.id, hostname }] : [];
        });
        const [live, known] = await Promise.all([
            liveHostnames([...new Set(candidates.map((candidate) => candidate.hostname))]),
            prisma.gameDnsRecord.findMany({
                where: {
                    zoneId: zone.id,
                    recordId: { in: candidates.map((candidate) => candidate.id) }
                },
                select: { recordId: true }
            })
        ]);
        const remembered = new Set(known.map((row) => row.recordId));
        let removedHere = 0;
        for (const candidate of candidates) {
            if (live.has(candidate.hostname) || remembered.has(candidate.id)) continue;
            if ((await deleteDnsRecordIfPresent(token, zone.id, candidate.id)) === "deleted")
                removedHere += 1;
        }
        removed += removedHere;
        if (!more) break;
        // A page that lost records shifts the next one back by as many: read this
        // page number again rather than skip what moved onto it.
        if (removedHere === 0) page += 1;
    }
    return removed;
}
