/**
 * Who may watch one server or one domain in Places.
 *
 * Both belong to an account: a server to whoever registered its host, a domain
 * to whoever owns the project it answers for. Either can be lent to watch - its
 * load, its answers and its alarm history - and nothing beyond that: its shell,
 * files, containers, address and settings stay with its owner.
 *
 * The machine Polaris runs on is never lent. It has no host row of its own
 * until it is enrolled, and even then it is the box every account on this
 * Polaris runs on, so whether anybody outside may watch it is the operator's
 * decision, not one a share dialog makes. Server-only.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { sessionCan } from "@/lib/session";
import type { SessionUser } from "@/lib/session";
import { liveGrants, type LiveGrant } from "@/lib/access/grants";
import { subjectBelongsToOwner } from "@/lib/metrics-history-service";
import { hostSubject, LOCAL_HOST_SUBJECT } from "@/lib/metrics-shared";
import { isLocalMachine, localMachineIdentity } from "@/lib/local-machine";

export type LentMachine = "place.server" | "place.domain";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Pure: whether any of these live grants lets them watch. */
export function watchesFrom(subject: LentMachine, held: readonly LiveGrant[]): boolean {
    return held.some((grant) => core.allowsAction(subject, grant.capability, grant.actions, "watch"));
}

/** Whether a server id names the machine Polaris runs on by its reserved ids. */
export function isLocalServerId(id: string): boolean {
    return id === core.LOCAL_SERVER_ID || id === LOCAL_HOST_SUBJECT;
}

/**
 * The host row a server id names, when it is one that can be lent: a registered
 * server that is not the machine Polaris runs on. Null otherwise.
 */
export async function lendableServer(id: string): Promise<{ id: string; ownerId: string; name: string } | null> {
    if (isLocalServerId(id) || !UUID.test(id)) return null;
    const host = await prisma.host.findUnique({
        where: { id },
        select: { id: true, ownerId: true, name: true, address: true, dockerId: true }
    });
    if (!host || isLocalMachine(host, await localMachineIdentity())) return null;
    return { id: host.id, ownerId: host.ownerId, name: host.name };
}

/** The account a domain belongs to, through its project. Null for no domain. */
export async function domainOwner(id: string): Promise<{ id: string; ownerId: string; hostname: string } | null> {
    if (!UUID.test(id)) return null;
    const domain = await prisma.domain.findUnique({
        where: { id },
        select: {
            id: true,
            hostname: true,
            application: { select: { environment: { select: { project: { select: { ownerId: true } } } } } }
        }
    });
    if (!domain) return null;
    return { id: domain.id, ownerId: domain.application.environment.project.ownerId, hostname: domain.hostname };
}

/** A server lent to this account to watch, and whose it is. Null for one that
 *  is theirs, one that cannot be lent, and one nobody lent them. */
export async function borrowedServer(
    userId: string,
    id: string
): Promise<{ id: string; ownerId: string; name: string } | null> {
    const host = await lendableServer(id);
    if (!host || host.ownerId === userId) return null;
    return watchesFrom("place.server", await liveGrants(userId, "place.server", host.id)) ? host : null;
}

/** A domain lent to this account to watch, and whose it is. */
export async function borrowedDomain(
    userId: string,
    id: string
): Promise<{ id: string; ownerId: string; hostname: string } | null> {
    const domain = await domainOwner(id);
    if (!domain || domain.ownerId === userId) return null;
    return watchesFrom("place.domain", await liveGrants(userId, "place.domain", domain.id)) ? domain : null;
}

/**
 * Whose load samples a reader may read for this server, or null for none: their
 * own, under the permission the Servers app asks, or the owner's for a server
 * lent to them. Nothing else is reached through a borrowed server.
 */
export async function serverMetricsOwner(user: SessionUser, id: string): Promise<string | null> {
    if (
        (await sessionCan(user, "deploy.read")) &&
        (await subjectBelongsToOwner("host", hostSubject(id), user.id).catch(() => false))
    ) {
        return user.id;
    }
    return (await borrowedServer(user.id, id))?.ownerId ?? null;
}
