/**
 * Keeping the operator's own domain pointed at this server as its address moves.
 *
 * A home connection's public address is not a constant. The ISP rotates it - on a
 * reconnect, on a lease expiry, on nothing at all - and the moment it does, every
 * A record Polaris wrote names an address that now belongs to somebody else. The
 * domain does not degrade: it refuses connections, instantly and completely,
 * while the server sits there healthy, the router forwards correctly, and nothing
 * anywhere says what happened. The operator is left looking at a router that is
 * fine and a dashboard that reports a domain "not answering".
 *
 * That was the shape of it: the records are written once, by the guided setup,
 * and nothing ever revisits them. A DuckDNS subdomain configured here has been
 * re-synced every ten minutes for exactly this reason; the operator's own zone,
 * on a provider Polaris holds an API token for, had no equivalent. This is that
 * equivalent.
 *
 * Two rules make it safe to run unattended:
 *
 * Nothing is written on a guess. The address has to be detected - not read from a
 * cache, not inferred - and a detection that fails means the sync does nothing at
 * all. A server that has briefly lost its internet connection must never conclude
 * from that silence that its address has changed.
 *
 * A record is only repointed when it was ours. One that points at the address we
 * last knew this server by has gone stale and is corrected; one that points
 * anywhere else is somebody's deliberate record - an apex serving their existing
 * website, most often - and it is reported rather than taken over. That
 * distinction is the whole difference between a sync and an outage of its own.
 */

import { prisma } from "@polaris/db";
import { getDomainZones } from "@/lib/domain-zones";
import { createNotification } from "@/lib/notification-service";
import { checkZoneDns, provisionZoneDns } from "@/lib/domain-dns";
import { detectPublicIp, networkPublicIp } from "@/lib/network-service";

/** How often the address is re-checked. The same cadence the DuckDNS sync runs
 *  at, and for the same reason: it is one outbound request, and the window it
 *  leaves is how long a rotated address keeps the domain down. */
const EVERY_MS = 10 * 60 * 1000;

/** Long enough after start that the first tick does not compete with everything
 *  else a boot is doing, short enough that an address rotated while the box was
 *  off is corrected before anybody notices. */
const FIRST_TICK_MS = 45_000;

export interface ZoneAddressSync {
    /** The address the records named before, when it was one of ours. */
    readonly from: string | null;
    /** The address this server answers on now. */
    readonly to: string | null;
    /** Names repointed at it. */
    readonly repointed: readonly string[];
    /** Names left alone because they point somewhere that was never this server,
     *  with what they point at. */
    readonly conflicts: readonly { readonly name: string; readonly content: string }[];
    /** Names that could not be written, with why. */
    readonly failed: readonly { readonly name: string; readonly detail: string }[];
    /** Why nothing was done, when nothing was. Null when the sync ran. */
    readonly skipped: string | null;
}

const NOTHING: ZoneAddressSync = { from: null, to: null, repointed: [], conflicts: [], failed: [], skipped: null };

/** One name in the layout and what it resolves to today. */
export interface NamedRecord {
    readonly name: string;
    readonly addresses: readonly string[];
}

/**
 * Split what no longer names this server into what this sync may correct and what
 * it must not touch.
 *
 * The whole safety of running unattended is here, so it is separate and pure. A
 * record that names the address this server used to answer on is one Polaris
 * wrote and the ISP invalidated - correcting it is the entire point. A record
 * naming anything else was put there by somebody, for something, and the obvious
 * example is the operator's apex serving the website they already had: repointing
 * that would take a live site down to fix a domain that was not broken.
 *
 * A name resolving to nothing is not stale, it is absent - creating it is the
 * guided setup's job, not a correction to make behind somebody's back.
 *
 * With no previous address known, nothing qualifies as ours. That is deliberate:
 * a fresh process cannot tell its own former address from a stranger's, and the
 * safe direction is to report rather than to take over.
 */
export function classifyStale(
    named: readonly NamedRecord[],
    current: string,
    previous: string | null
): { readonly ours: NamedRecord[]; readonly theirs: NamedRecord[] } {
    const stale = named.filter((entry) => entry.addresses.length > 0 && !entry.addresses.includes(current));
    const ours = stale.filter(
        (entry) => previous !== null && previous !== current && entry.addresses.every((address) => address === previous)
    );
    return { ours, theirs: stale.filter((entry) => !ours.includes(entry)) };
}

/**
 * Check what this server's public address is now, and repoint the zone's records
 * at it when they have fallen behind.
 *
 * Idempotent and quiet: on the overwhelming majority of runs the address has not
 * moved, the records already agree, and this costs one HTTP request and a
 * handful of DNS lookups.
 */
export async function syncZoneAddress(): Promise<ZoneAddressSync> {
    const config = await getDomainZones().catch(() => null);
    if (!config?.baseDomain) return { ...NOTHING, skipped: "No domain is configured" };

    // Read before detecting: detection overwrites the remembered value, and the
    // one it overwrites is how a stale record is recognised as ours.
    const previous = await networkPublicIp().catch(() => null);
    const current = await detectPublicIp(true).catch(() => null);
    if (!current) return { ...NOTHING, skipped: "This server's public address could not be detected" };

    const report = await checkZoneDns().catch(() => null);
    if (!report) return { ...NOTHING, skipped: "The zone's records could not be read" };

    // Everything the layout names, zones and each game's wildcard alike: a game
    // wildcard left behind is every server of that game unreachable.
    const named = [
        ...report.zones.flatMap((zone) => [
            { name: zone.host, addresses: zone.addresses },
            { name: zone.wildcard, addresses: zone.addresses }
        ]),
        ...report.gameZones.map((zone) => ({ name: zone.wildcard, addresses: zone.addresses }))
    ];
    // Ours and out of date, or somebody else's. Only the first kind is corrected.
    const { ours, theirs } = classifyStale(named, current, previous);
    if (ours.length === 0 && theirs.length === 0) return { ...NOTHING, from: previous, to: current };
    if (ours.length === 0) {
        await warn(
            config.baseDomain,
            current,
            theirs.map((entry) => ({ name: entry.name, content: entry.addresses.join(", ") }))
        );
        return {
            ...NOTHING,
            from: previous,
            to: current,
            conflicts: theirs.map((entry) => ({ name: entry.name, content: entry.addresses.join(", ") })),
            skipped: "The records point somewhere this server has never answered on"
        };
    }

    const written = await provisionZoneDns({ overwrite: true }).catch((caught: unknown) => {
        return { error: caught instanceof Error ? caught.message : "The records could not be written" };
    });
    if ("error" in written) {
        await warn(config.baseDomain, current, [], written.error);
        return { ...NOTHING, from: previous, to: current, skipped: written.error };
    }

    const repointed = [...written.created, ...written.replaced];
    if (repointed.length > 0) await announce(config.baseDomain, previous, current, repointed.length);
    return {
        from: previous,
        to: current,
        repointed,
        conflicts: written.conflicts,
        failed: written.failed,
        skipped: null
    };
}

/** Told to whoever administers this Polaris. The address is instance-wide and
 *  belongs to nobody in particular, so it goes to the people who could act on it. */
async function administrators(): Promise<string[]> {
    const rows = await prisma.user
        .findMany({ where: { isAdmin: true }, select: { id: true } })
        .catch(() => []);
    return rows.map((row) => row.id);
}

/** What was put right, so a domain that went down and came back is a thing that
 *  happened rather than a mystery somebody half-noticed. */
async function announce(domain: string, from: string | null, to: string, records: number): Promise<void> {
    for (const userId of await administrators()) {
        await createNotification({
            userId,
            type: "domain.address-changed",
            title: `${domain} now points at ${to}`,
            body: from
                ? `This server's public address changed from ${from} to ${to}, so ${records} DNS ${records === 1 ? "record was" : "records were"} repointed. Nothing else was touched.`
                : `This server's public address is ${to}, so ${records} DNS ${records === 1 ? "record was" : "records were"} repointed.`,
            href: "/admin/domains",
            level: "info"
        });
    }
}

/** And what could not be, which is the case that needs somebody. */
async function warn(
    domain: string,
    current: string,
    conflicts: readonly { name: string; content: string }[],
    detail?: string
): Promise<void> {
    const body = detail
        ? `This server now answers on ${current}, but the records could not be updated: ${detail}`
        : `This server now answers on ${current}, but ${conflicts.map((entry) => entry.name).join(", ")} points at ${conflicts.map((entry) => entry.content).join(", ")}. Polaris does not repoint a record it did not write - change it yourself if it should name this server.`;
    for (const userId of await administrators()) {
        await createNotification({
            userId,
            type: "domain.address-stale",
            title: `${domain} does not point at this server`,
            body,
            href: "/admin/domains",
            level: "warning",
            actionRequired: true
        });
    }
}

let started = false;

/** Run the sync for as long as this process lives. Idempotent, and a no-op until
 *  a domain is configured. */
export function startZoneAddressSync(): void {
    if (started) return;
    started = true;
    const tick = (): void => void syncZoneAddress().catch(() => undefined);
    setInterval(tick, EVERY_MS).unref?.();
    setTimeout(tick, FIRST_TICK_MS).unref?.();
}
