/**
 * Reading, checking and setting an organization's quota.
 *
 * Each create path calls the check before it writes, so a cap holds whichever
 * screen, import or template the request came from. An organization with no
 * quota row costs one primary-key read and nothing else; usage is only counted
 * once a cap exists for the thing being created.
 *
 * Nothing here removes anything: an organization already past a cap keeps what
 * it has, and is only refused the next one.
 */

import * as quotas from "./quotas";
import { OrgError } from "./errors";
import { prisma } from "@polaris/db";
import { DEFAULT_LOCALE } from "@polaris/core";
import { translatorFor } from "@/lib/i18n/translate";

/** A create or a change turned down because the organization is at a cap. The
 *  message is the reader's, in their language; the fields are for code. */
export class OrgQuotaError extends OrgError {
    constructor(
        message: string,
        readonly dimension: quotas.OrgQuotaDimension,
        readonly limit: number
    ) {
        super(message);
        this.name = "OrgQuotaError";
    }
}

/** The refusal in the reader's language. Loaded only when one is thrown, since
 *  the request's locale reaches into the session; outside a request (a sweep, a
 *  queued job) it falls back to the default language rather than failing. */
async function refusalWords() {
    try {
        const { getTranslations } = await import("@/lib/i18n/request");
        return await getTranslations("accountOrgs");
    } catch {
        return translatorFor(DEFAULT_LOCALE, "accountOrgs");
    }
}

export async function quotaRefusal(
    dimension: quotas.OrgQuotaDimension,
    limit: number
): Promise<OrgQuotaError> {
    const t = await refusalWords();
    return new OrgQuotaError(t(`quotas.refused.${dimension}`, { limit }), dimension, limit);
}

/** The organization's caps, or null when none was ever set. */
export async function getOrgQuota(orgId: string): Promise<quotas.OrgQuotaLimits | null> {
    const row = await prisma.organizationQuota.findUnique({ where: { orgId } });
    if (!row) return null;
    return {
        members: row.members,
        teams: row.teams,
        projects: row.projects,
        services: row.services,
        databases: row.databases,
        cpus: row.cpus,
        memoryMb: row.memoryMb
    };
}

/** Write every cap at once; a quota with nothing left in it is removed, so the
 *  organization is back to the no-row fast path. */
export async function setOrgQuota(orgId: string, limits: quotas.OrgQuotaInput): Promise<void> {
    if (quotas.ORG_QUOTA_DIMENSIONS.every((dimension) => limits[dimension] === null)) {
        await prisma.organizationQuota.deleteMany({ where: { orgId } });
        return;
    }
    await prisma.organizationQuota.upsert({
        where: { orgId },
        create: { orgId, ...limits },
        update: limits
    });
}

const inOrg = (orgId: string) => ({ binnedAt: null, environment: { project: { orgId } } });

/**
 * Places an organization's people take: the owner, the roster, and every
 * invitation still open, in the app or emailed. `except` leaves out the person
 * being made room for, so their own invitation is not counted twice.
 */
export async function seatsTaken(
    orgId: string,
    except: { userId?: string | null; inviteId?: string } = {}
): Promise<number> {
    const now = new Date();
    const [members, invited, emailed] = await Promise.all([
        prisma.organizationMember.count({ where: { orgId } }),
        prisma.organizationInvitation.count({
            where: {
                orgId,
                expiresAt: { gt: now },
                ...(except.userId ? { userId: { not: except.userId } } : {})
            }
        }),
        prisma.invite.count({
            where: {
                orgId,
                acceptedAt: null,
                expiresAt: { gt: now },
                ...(except.inviteId ? { id: { not: except.inviteId } } : {})
            }
        })
    ]);
    return members + invited + emailed + 1;
}

/** How many of one thing the organization holds now. Members count the owner,
 *  who is never a member row. */
export async function countOrgUsage(
    orgId: string,
    dimension: quotas.OrgQuotaCount
): Promise<number> {
    switch (dimension) {
        case "members":
            return seatsTaken(orgId);
        case "teams":
            return prisma.team.count({ where: { orgId } });
        case "projects":
            return prisma.project.count({ where: { orgId, binnedAt: null } });
        case "services":
            return prisma.application.count({ where: inOrg(orgId) });
        case "databases":
            return prisma.managedDatabase.count({ where: inOrg(orgId) });
    }
}

export interface ReservationExclusion {
    applicationId?: string;
    databaseId?: string;
}

/**
 * CPU cores and memory reserved across the organization: each limit times the
 * copies it runs, or the most its autoscaling may run. Grouped by copy count and
 * autoscaling range in the database, so the answer is a handful of rows however
 * many services there are. A database hosted on another
 * instance has no container of its own and reserves nothing.
 */
export async function reservedByOrg(
    orgId: string,
    exclude: ReservationExclusion = {}
): Promise<{ cpus: number; memoryMb: number }> {
    const [applications, databases] = await Promise.all([
        prisma.application.groupBy({
            by: ["replicas", "autoscale"],
            where: {
                ...inOrg(orgId),
                ...(exclude.applicationId ? { id: { not: exclude.applicationId } } : {})
            },
            _sum: { cpuLimit: true, memoryLimitMb: true }
        }),
        prisma.managedDatabase.groupBy({
            by: ["members"],
            where: {
                ...inOrg(orgId),
                parentId: null,
                ...(exclude.databaseId ? { id: { not: exclude.databaseId } } : {})
            },
            _sum: { cpuLimit: true, memoryLimitMb: true }
        })
    ]);
    let cpus = 0;
    let memoryMb = 0;
    for (const group of applications) {
        const copies = quotas.copiesReserved(group.replicas, group.autoscale);
        cpus += quotas.reservationOf(group._sum.cpuLimit, copies);
        memoryMb += quotas.reservationOf(group._sum.memoryLimitMb, copies);
    }
    for (const group of databases) {
        cpus += quotas.reservationOf(group._sum.cpuLimit, group.members);
        memoryMb += quotas.reservationOf(group._sum.memoryLimitMb, group.members);
    }
    return { cpus: Math.round(cpus * 100) / 100, memoryMb };
}

/** Everything the Limits screen draws, read in one round of queries. */
export async function orgQuotaUsage(orgId: string): Promise<quotas.OrgQuotaUsage> {
    const [counts, reserved] = await Promise.all([
        Promise.all(quotas.ORG_QUOTA_COUNTS.map((dimension) => countOrgUsage(orgId, dimension))),
        reservedByOrg(orgId)
    ]);
    const usage = Object.fromEntries(
        quotas.ORG_QUOTA_COUNTS.map((dimension, i) => [dimension, counts[i] ?? 0])
    );
    return { ...(usage as Record<quotas.OrgQuotaCount, number>), ...reserved };
}

/**
 * Refuse `adding` more of `dimension` (one, unless a restore brings several back
 * at once) when they would not fit under the organization's cap. Personal things
 * (no organization) are never capped here. Members and teams are checked by their
 * own services, which also hold the instance's cap.
 *
 * The count and the insert after it are not one transaction, so two creates
 * racing at the last place can both pass and leave the organization one over.
 * That is accepted: a cap here is an allowance, not a safety limit, nothing is
 * lost by the overshoot, and the next create is refused as usual.
 */
export async function assertOrgRoom(
    orgId: string | null | undefined,
    dimension: "projects" | "services" | "databases",
    adding = 1
): Promise<void> {
    if (!orgId || adding <= 0) return;
    const limit = (await getOrgQuota(orgId))?.[dimension] ?? null;
    if (limit === null) return;
    const current = await countOrgUsage(orgId, dimension);
    if (!quotas.roomForOne(limit, current + adding - 1)) throw await quotaRefusal(dimension, limit);
}

/** The organization an environment's project sits on, or null for a personal one. */
export async function orgIdOfEnvironment(environmentId: string): Promise<string | null> {
    const environment = await prisma.environment.findUnique({
        where: { id: environmentId },
        select: { project: { select: { orgId: true } } }
    });
    return environment?.project.orgId ?? null;
}

/** The organization a service's project sits on, or null for a personal one. */
export async function orgIdOfApplication(applicationId: string): Promise<string | null> {
    const application = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { environment: { select: { project: { select: { orgId: true } } } } }
    });
    return application?.environment.project.orgId ?? null;
}

/** The organization a database's project sits on, or null for a personal one. */
export async function orgIdOfDatabase(databaseId: string): Promise<string | null> {
    const database = await prisma.managedDatabase.findUnique({
        where: { id: databaseId },
        select: { environment: { select: { project: { select: { orgId: true } } } } }
    });
    return database?.environment.project.orgId ?? null;
}

/** `assertOrgRoom` for a service or database about to be made in an environment. */
export async function assertEnvironmentRoom(
    environmentId: string,
    dimension: "services" | "databases"
): Promise<void> {
    await assertOrgRoom(await orgIdOfEnvironment(environmentId), dimension);
}

export interface Reservation {
    cpus: number;
    memoryMb: number;
}

/**
 * Refuse a service or database growing what it reserves past the organization's
 * caps. `previous` is what it reserved before the change (zero for a new one)
 * and `exclude` names it, so it is not counted twice. Shrinking always passes.
 * `org` is the organization, or a lookup of it that only runs when something
 * grows.
 */
export async function assertOrgReservation(
    org: string | null | undefined | (() => Promise<string | null>),
    previous: Reservation,
    next: Reservation,
    exclude: ReservationExclusion = {}
): Promise<void> {
    // A change that grows nothing is never refused, so it costs no read at all -
    // not even the organization's, which a caller may pass as a lookup.
    if (next.cpus <= previous.cpus && next.memoryMb <= previous.memoryMb) return;
    const orgId = typeof org === "function" ? await org() : org;
    if (!orgId) return;
    const quota = await getOrgQuota(orgId);
    if (!quota || (quota.cpus === null && quota.memoryMb === null)) return;
    const others = await reservedByOrg(orgId, exclude);
    for (const dimension of quotas.ORG_QUOTA_RESERVATIONS) {
        const limit = quota[dimension];
        if (
            !quotas.roomForReservation(
                limit,
                others[dimension],
                previous[dimension],
                next[dimension]
            )
        ) {
            throw await quotaRefusal(dimension, limit ?? 0);
        }
    }
}
