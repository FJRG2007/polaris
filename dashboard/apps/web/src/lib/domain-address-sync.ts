/**
 * Keeping the operator's own domain pointed at this server as its address moves.
 *
 * A home connection's public address is not a constant. The ISP rotates it - on a
 * reconnect, on a lease expiry, on nothing at all - and the moment it does, every
 * A record Polaris wrote names an address that now belongs to somebody else. The
 * domain does not degrade: it refuses connections, instantly and completely,
 * while the server sits there healthy and nothing anywhere says what happened.
 *
 * This is the guided setup's "Point them at this server" run on a schedule, under
 * rules that make it safe to run unattended:
 *
 * Nothing is written on a guess. The address has to be read twice, from two
 * different echo services, and the two have to agree. A failed or disagreeing
 * lookup does nothing at all.
 *
 * A record is only repointed when it was ours. The names are exactly the ones the
 * setup asked for (`ownedZoneNames`), read from Cloudflare itself rather than from
 * a resolver that may hold a cached answer, and a record is edited only when it
 * holds the address Polaris last published - or, before anything was published,
 * an address this box answered on before. Anything else is somebody's deliberate
 * record and is reported, never taken over. The record is edited in place, so its
 * proxy flag and TTL are the operator's, and no second record is ever added.
 *
 * The earlier version recognised "ours" by the remembered detected address, read
 * just before detecting. Seventeen other places refresh that value, and once any
 * of them had, the old records looked like a stranger's and stayed stale for good.
 * The published address is written only here, so nothing else can move it.
 */

import { prisma } from "@polaris/db";
import { isPublicIpv4, PUBLIC_IP_CHANGED_EVENT } from "@polaris/core";
import { backupAccessActive } from "@/lib/backup-access";
import { INBOUND_KEY, mayPublish, readReach } from "@/lib/backup-access/inbound";
import { publicA } from "@/lib/dns/authoritative";
import { getSetting, setSetting } from "@/lib/setting-store";
import * as notices from "@/lib/notification-service";
import { emitAutomationEvent } from "@/lib/automations/outbox";
import { wordsFor } from "@/lib/notifications/notice-words";
import { getDomainZones, polarisZoneHost } from "@/lib/domain-zones";
import { ownedZoneNames } from "@/lib/domain-dns";
import { loadCloudflareToken } from "@/lib/integrations/cloudflare-account-service";
import { probePublicIp, publicIpHistory, rememberPublicIp } from "@/lib/network-service";
import {
    deleteDnsRecord,
    findDnsRecords,
    repointRecord,
    resolveZoneForHostname,
    type CfDnsRecord
} from "@/lib/integrations/cloudflare-api";

/** The address Polaris last pointed its records at. Written only by this module. */
export const PUBLISHED_KEY = "network.dnsPublishedIp";
/** Addresses Polaris wrote into a record since the last run that published, so a
 *  record repointed by a run that partly failed is still recognised as ours. */
export const WRITTEN_KEY = "network.dnsWrittenIps";
/** How many of those are kept: a run that never completes cannot grow the list. */
const WRITTEN_MAX = 8;
/** The address the last confirmed run saw, so a change is announced once. */
const LAST_SEEN_KEY = "network.dnsFollowLastIp";
/** The setting the once-per-streak check used before conditions existed. Cleared
 *  on the next run so nothing is left behind; never read. */
const FAILING_KEY = "network.dnsFollowFailing";
/** The open problems this job raises, one notice each, rewritten while they hold. */
const STALE_CONDITION = "domain.address-stale";
const UNREACHED_CONDITION = "domain.address-unreached";
/** What the last run found, for Admin -> Domains. */
export const STATUS_KEY = "network.dnsFollowStatus";

export { PUBLIC_IP_CHANGED_EVENT };

/** How long past the record's TTL the outside answer may still be old before it is told. */
const REACH_GRACE_MS = 2 * 60 * 1000;
/** What Cloudflare's "automatic" TTL (1) means in seconds. */
const AUTO_TTL_S = 300;

export type FollowProblem =
    "no-token" | "api" | "conflict" | "failed" | "unreached" | "cgnat" | "not-public";

/** What the last run found, as Admin -> Domains shows it. */
export interface FollowStatus {
    readonly checkedAt: string;
    /** The address this server answers on, when two reads agreed. */
    readonly ip: string | null;
    readonly publishedIp: string | null;
    readonly updatedAt: string | null;
    readonly updatedCount: number;
    readonly problem: FollowProblem | null;
    /** Why, in words, when there is a problem. */
    readonly detail: string | null;
    /** While waiting for the outside world to see a change: when it should have. */
    readonly reachBy: string | null;
}

/** A name the follower owns and the A records it holds today. */
export interface OwnedName {
    readonly name: string;
    readonly records: readonly CfDnsRecord[];
}

export interface RepointPlan {
    /** Records to edit in place to the current address. */
    readonly repoint: readonly { readonly name: string; readonly record: CfDnsRecord }[];
    /** Our stale records on a name that already has a record for the current
     *  address: removed, so the name stops round-robining onto the old one. */
    readonly drop: readonly { readonly name: string; readonly record: CfDnsRecord }[];
    /** Records naming an address that was never ours. Left alone and reported. */
    readonly conflicts: readonly { readonly name: string; readonly content: string }[];
    /** Names already pointing only here. */
    readonly settled: readonly string[];
}

/**
 * Which addresses count as this server's former ones. The published address when
 * there is one - and then only it. Before anything was published (an install that
 * predates this, or the first run), the addresses detection has seen before, and
 * the address the dashboard's own hostname points at: the dashboard was reached
 * on that name, so whatever it named was this box, unless Cloudflare's proxy sits
 * in front of it.
 */
export function formerAddresses(
    published: string | null,
    history: readonly string[],
    dashboardRecords: readonly CfDnsRecord[],
    current: string,
    written: readonly string[] = []
): Set<string> {
    const candidates = published
        ? [published, ...written]
        : [
              ...written,
              ...history,
              ...dashboardRecords
                  .filter((record) => !record.proxied)
                  .map((record) => record.content)
          ];
    return new Set(candidates.filter((ip) => ip !== current && isPublicIpv4(ip)));
}

/**
 * Split what the owned names hold into what may be corrected and what must not
 * be touched. Pure, because the whole safety of running unattended is here.
 *
 * A name with no record is absent, not stale: creating it is the guided setup's
 * job. A name holding several records keeps the ones that are not ours.
 */
export function planRepoint(
    names: readonly OwnedName[],
    current: string,
    former: ReadonlySet<string>
): RepointPlan {
    const repoint: { name: string; record: CfDnsRecord }[] = [];
    const drop: { name: string; record: CfDnsRecord }[] = [];
    const conflicts: { name: string; content: string }[] = [];
    const settled: string[] = [];
    for (const { name, records } of names) {
        if (records.length === 0) continue;
        const stale = records.filter((record) => record.content !== current);
        if (stale.length === 0) {
            settled.push(name);
            continue;
        }
        let pointsHere = records.length > stale.length;
        for (const record of stale) {
            if (!former.has(record.content)) {
                conflicts.push({ name, content: record.content });
                continue;
            }
            // Edit one in place; any further stale one of ours would become a second
            // record with the same address, so it goes instead.
            if (pointsHere) drop.push({ name, record });
            else {
                repoint.push({ name, record });
                pointsHere = true;
            }
        }
    }
    return { repoint, drop, conflicts, settled };
}

export interface ZoneAddressSync {
    readonly from: string | null;
    readonly to: string | null;
    readonly repointed: readonly string[];
    readonly conflicts: readonly { readonly name: string; readonly content: string }[];
    readonly failed: readonly { readonly name: string; readonly detail: string }[];
    /** Why nothing was done, when nothing was. Null when the sync ran. */
    readonly skipped: string | null;
}

const NOTHING: ZoneAddressSync = {
    from: null,
    to: null,
    repointed: [],
    conflicts: [],
    failed: [],
    skipped: null
};

function message(caught: unknown): string {
    return caught instanceof Error ? caught.message : "Cloudflare refused the request";
}

async function readWritten(): Promise<string[]> {
    try {
        const raw = await getSetting(WRITTEN_KEY);
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        return Array.isArray(parsed)
            ? parsed.filter((ip): ip is string => typeof ip === "string")
            : [];
    } catch {
        return [];
    }
}

async function readStatus(): Promise<FollowStatus | null> {
    try {
        const raw = await getSetting(STATUS_KEY);
        return raw ? (JSON.parse(raw) as FollowStatus) : null;
    } catch {
        return null;
    }
}

/** What Admin -> Domains shows: the last run's outcome and the published address. */
export async function followStatus(): Promise<FollowStatus | null> {
    const [status, published] = await Promise.all([readStatus(), getSetting(PUBLISHED_KEY)]);
    if (!status) return published ? { ...EMPTY_STATUS, publishedIp: published } : null;
    return { ...status, publishedIp: published };
}

/** The Domains card's answer: whether there is a domain to follow at all, and the status. */
export interface AddressFollowView {
    readonly configured: boolean;
    readonly status: FollowStatus | null;
}

export async function addressFollowView(): Promise<AddressFollowView> {
    const [config, status] = await Promise.all([
        getDomainZones().catch(() => null),
        followStatus()
    ]);
    return { configured: Boolean(config?.baseDomain), status };
}

const EMPTY_STATUS: FollowStatus = {
    checkedAt: "",
    ip: null,
    publishedIp: null,
    updatedAt: null,
    updatedCount: 0,
    problem: null,
    detail: null,
    reachBy: null
};

/**
 * Read the address, and repoint the owned records that still name a former one.
 * Idempotent and quiet: on almost every run the address has not moved, and this
 * costs two echo requests and one Cloudflare read per owned name.
 */
export async function syncZoneAddress(): Promise<ZoneAddressSync> {
    if (await backupAccessActive())
        return { ...NOTHING, skipped: "Backup access owns the records" };
    const config = await getDomainZones().catch(() => null);
    if (!config?.baseDomain) return { ...NOTHING, skipped: "No domain is configured" };

    const previous = await readStatus();
    const now = new Date();
    const save = (status: Partial<FollowStatus>): Promise<void> =>
        setSetting(
            STATUS_KEY,
            JSON.stringify({
                ...EMPTY_STATUS,
                ...previous,
                ...status,
                checkedAt: now.toISOString()
            })
        );

    // Two reads from different services, and only an agreement counts. One that
    // fails or disagrees is a flaky lookup, never a reason to rewrite DNS.
    const [first, second] = await Promise.all([probePublicIp(0), probePublicIp(2)]);
    if (!first || first !== second) {
        await save({});
        return { ...NOTHING, skipped: "The public address could not be confirmed" };
    }
    const current = first;
    await rememberPublicIp(current);

    const [published, lastSeen, history, written] = await Promise.all([
        getSetting(PUBLISHED_KEY),
        getSetting(LAST_SEEN_KEY),
        publicIpHistory(),
        readWritten()
    ]);
    const from = lastSeen && lastSeen !== current ? lastSeen : null;
    if (from) await announceChange(from, current);
    if (lastSeen !== current) await setSetting(LAST_SEEN_KEY, current);

    // An address behind a carrier NAT takes no visitors: pointing the records at it
    // sends them to somebody else's router. The records stay where they are and
    // backup access, when a path is chosen, takes them over.
    const gate = mayPublish({
        ip: current,
        reach: readReach(await getSetting(INBOUND_KEY)),
        backupServing: false
    });
    if (gate.refusal === "cgnat" || gate.refusal === "not-public") {
        await save({ ip: current, problem: gate.refusal, detail: null, reachBy: null });
        return { ...NOTHING, from, to: current, skipped: "The address takes no visitors" };
    }

    const token = await loadCloudflareToken().catch(() => null);
    if (!token) {
        // Only worth saying when the records may now be wrong: on an install that
        // never connected Cloudflare and whose address has not moved, it is noise.
        if (from || (published && published !== current)) {
            await fail(config.baseDomain, current, "no-token", null);
        }
        await save({ ip: current, problem: "no-token", detail: null });
        return { ...NOTHING, from, to: current, skipped: "No Cloudflare token is connected" };
    }

    let owned: OwnedName[];
    let zoneId: string;
    try {
        zoneId = (await resolveZoneForHostname(token, config.baseDomain)).id;
        owned = [];
        // Sequential: Cloudflare rate-limits per account (see provisionZoneDns).
        for (const name of await ownedZoneNames(config)) {
            owned.push({ name, records: await findDnsRecords(token, zoneId, "A", name) });
        }
    } catch (caught) {
        await fail(config.baseDomain, current, "api", message(caught));
        await save({ ip: current, problem: "api", detail: message(caught) });
        return { ...NOTHING, from, to: current, skipped: message(caught) };
    }

    const dashboardHost = await polarisZoneHost().catch(() => null);
    const former = formerAddresses(
        published,
        history,
        owned.find((entry) => entry.name === dashboardHost)?.records ?? [],
        current,
        written
    );
    const plan = planRepoint(owned, current, former);

    const repointed: string[] = [];
    const failed: { name: string; detail: string }[] = [];
    let ttl = 0;
    for (const { name, record } of plan.repoint) {
        try {
            await repointRecord(token, zoneId, record.id, current);
            repointed.push(name);
            ttl = Math.max(
                ttl,
                record.ttl === undefined || record.ttl <= 1 ? AUTO_TTL_S : record.ttl
            );
        } catch (caught) {
            failed.push({ name, detail: message(caught) });
        }
    }
    for (const { name, record } of plan.drop) {
        await deleteDnsRecord(token, zoneId, record.id).catch((caught: unknown) => {
            failed.push({ name, detail: message(caught) });
        });
    }

    // Everything owned now points here: that is what was published.
    if (failed.length === 0 && (repointed.length > 0 || plan.settled.length > 0)) {
        if (published !== current) await setSetting(PUBLISHED_KEY, current);
        if (written.length > 0) await setSetting(WRITTEN_KEY, null);
    } else if (repointed.length > 0 && !written.includes(current)) {
        await setSetting(WRITTEN_KEY, JSON.stringify([current, ...written].slice(0, WRITTEN_MAX)));
    }

    const reachBy =
        repointed.length > 0
            ? new Date(now.getTime() + ttl * 1000 + REACH_GRACE_MS).toISOString()
            : (previous?.reachBy ?? null);
    const probed = owned.find((entry) => entry.name === dashboardHost) ?? owned[0];
    const reach = reachBy
        ? await checkReach(config.baseDomain, probed, current, reachBy, now)
        : null;

    const problem: FollowProblem | null =
        failed.length > 0
            ? "failed"
            : plan.conflicts.length > 0
              ? "conflict"
              : reach === "unreached"
                ? "unreached"
                : null;
    const detail =
        failed.length > 0
            ? failed.map((entry) => `${entry.name}: ${entry.detail}`).join("; ")
            : plan.conflicts.length > 0
              ? plan.conflicts.map((entry) => `${entry.name} -> ${entry.content}`).join(", ")
              : null;
    if (problem === "failed") await fail(config.baseDomain, current, "failed", detail);
    else if (problem === "conflict")
        await fail(config.baseDomain, current, "conflict", null, plan.conflicts);
    if (reach !== "unreached") await notices.resolveCondition(UNREACHED_CONDITION);
    // One notice per change: what was repointed, or that it moved with nothing to do.
    // A problem has its own notice above, which names the new address. When one
    // is open, the good news is written over it instead of beside it.
    if (problem === null) {
        await settle(
            config.baseDomain,
            current,
            repointed.length > 0 ? (from ?? [...former][0] ?? null) : null,
            repointed.length,
            from
        );
    } else if (repointed.length > 0) {
        await announceUpdated(
            config.baseDomain,
            from ?? [...former][0] ?? null,
            current,
            repointed.length
        );
    }

    await save({
        ip: current,
        problem,
        detail,
        reachBy: reach === "pending" ? reachBy : null,
        ...(repointed.length > 0
            ? { updatedAt: now.toISOString(), updatedCount: repointed.length }
            : {})
    });
    return { from, to: current, repointed, conflicts: plan.conflicts, failed, skipped: null };
}

/**
 * Whether the outside world sees the dashboard's hostname at the current address,
 * asked of public resolvers rather than this box's own (which may sit behind a
 * filter that caches). "pending" until the record's TTL plus a grace has passed;
 * after that one notice, and the wait ends. A proxied name answers with
 * Cloudflare's addresses, never this one, so there is nothing to compare.
 */
async function checkReach(
    domain: string,
    probed: OwnedName | undefined,
    current: string,
    reachBy: string,
    now: Date
): Promise<"reached" | "pending" | "unreached"> {
    if (!probed || probed.records.some((record) => record.proxied)) return "reached";
    const host = probed.name;
    const probe = host.startsWith("*.") ? `polaris-check.${host.slice(2)}` : host;
    const seen = await publicA(probe);
    if (seen.length > 0 && seen.every((address) => address === current)) return "reached";
    if (now.getTime() < new Date(reachBy).getTime()) return "pending";
    await notifyAdmins(
        UNREACHED_CONDITION,
        async (t) => ({
            type: "domain.address-unreached",
            title: t("domainAddress.unreachedTitle", { domain }),
            body: t("domainAddress.unreachedBody", { current, seen: seen.join(", ") || "-" }),
            level: "warning",
            actionRequired: true
        }),
        current
    );
    return "unreached";
}

/** Told to whoever administers this Polaris: the address is instance-wide. */
async function administrators(): Promise<string[]> {
    const rows = await prisma.user
        .findMany({ where: { isAdmin: true }, select: { id: true } })
        .catch(() => []);
    return rows.map((row) => row.id);
}

type Notice = Pick<
    notices.NotificationInput,
    "type" | "title" | "body" | "level" | "actionRequired"
>;
type Words = Awaited<ReturnType<typeof wordsFor<"notices">>>;

/**
 * One notice per administrator. With a condition, the open one is rewritten, and
 * put back to unread when `signature` (what the problem is) differs from the one
 * it was raised for.
 */
async function notifyAdmins(
    condition: string | null,
    build: (t: Words) => Promise<Notice> | Notice,
    signature?: string
): Promise<void> {
    for (const userId of await administrators()) {
        const t = await wordsFor(userId, "notices");
        const input = { userId, href: "/admin/domains", ...(await build(t)) };
        if (!condition) {
            await notices.createNotification(input);
            continue;
        }
        const open = (await notices.openConditions(userId, condition)).find(
            (entry) => entry.conditionKey === condition
        );
        const resurface =
            signature !== undefined && open !== undefined && open.metadata.signature !== signature;
        await notices.raiseCondition(
            condition,
            { ...input, metadata: signature === undefined ? null : { signature } },
            { resurface }
        );
    }
}

/**
 * Nothing is wrong now. An open "does not point at this server" notice is closed
 * with what happened (repointed, or fixed by hand); without one, a repoint or a
 * move is announced on its own, as before. Rows from before conditions existed
 * carry no key, so they are marked read by type as well.
 */
async function settle(
    domain: string,
    current: string,
    from: string | null,
    count: number,
    moved: string | null
): Promise<void> {
    const legacy = await getSetting(FAILING_KEY);
    if (legacy !== null) await setSetting(FAILING_KEY, null);
    let closed = 0;
    for (const userId of await administrators()) {
        const t = await wordsFor(userId, "notices");
        closed += await notices.resolveCondition(STALE_CONDITION, {
            userIds: [userId],
            recovery: {
                title:
                    count > 0
                        ? t("domainAddress.pointsTitle", { domain, to: current })
                        : t("domainAddress.fixedTitle", { domain }),
                body:
                    count > 0
                        ? from
                            ? t("domainAddress.changedBody", { from, to: current, count })
                            : t("domainAddress.setBody", { to: current, count })
                        : t("domainAddress.fixedBody", { current }),
                level: "success"
            }
        });
    }
    if (legacy !== null)
        await notices.markNotificationsReadByType([STALE_CONDITION]).catch(() => {});
    if (closed > 0) return;
    if (count > 0) await announceUpdated(domain, from, current, count);
    else if (moved) await announceMoved(moved, current);
}

/** The address moved: handed to automations, whatever happens to the records. */
async function announceChange(from: string, to: string): Promise<void> {
    for (const userId of await administrators()) {
        await emitAutomationEvent("core.event", {
            userId,
            subjectKey: PUBLIC_IP_CHANGED_EVENT,
            payload: { name: PUBLIC_IP_CHANGED_EVENT, payload: { from, to } },
            dedupeKey: `${PUBLIC_IP_CHANGED_EVENT}:${userId}:${from}:${to}:${Math.floor(Date.now() / 60_000)}`
        });
    }
}

/** The address moved and there was nothing to repoint and nothing wrong: still said. */
async function announceMoved(from: string, to: string): Promise<void> {
    await notifyAdmins(null, (t) => ({
        type: "domain.address-moved",
        title: t("domainAddress.movedTitle", { to }),
        body: t("domainAddress.movedBody", { from, to }),
        level: "info"
    }));
}

async function announceUpdated(
    domain: string,
    from: string | null,
    to: string,
    count: number
): Promise<void> {
    await notifyAdmins(null, (t) => ({
        type: "domain.address-changed",
        title: t("domainAddress.pointsTitle", { domain, to }),
        body: from
            ? t("domainAddress.changedBody", { from, to, count })
            : t("domainAddress.setBody", { to, count }),
        level: "info"
    }));
}

/** A problem: one notice while it lasts, kept current rather than repeated. */
async function fail(
    domain: string,
    current: string,
    problem: FollowProblem,
    detail: string | null,
    conflicts: readonly { name: string; content: string }[] = []
): Promise<void> {
    await notifyAdmins(
        STALE_CONDITION,
        (t) => ({
            type: "domain.address-stale",
            title: t("domainAddress.staleTitle", { domain }),
            body:
                problem === "no-token"
                    ? t("domainAddress.noToken", { current, domain })
                    : problem === "conflict"
                      ? t("domainAddress.conflict", {
                            current,
                            names: conflicts.map((entry) => entry.name).join(", "),
                            contents: [...new Set(conflicts.map((entry) => entry.content))].join(
                                ", "
                            )
                        })
                      : t("domainAddress.notUpdated", { current, detail: detail ?? "-" }),
            level: "warning",
            actionRequired: true
        }),
        `${problem}:${current}`
    );
}
