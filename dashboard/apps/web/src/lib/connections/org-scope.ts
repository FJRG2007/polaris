/**
 * Who may manage the connections an organization owns.
 *
 * One permission, asked in one place, so the organization's Connections screen
 * and every action behind it agree about who is offered Connect and Remove:
 * whoever may manage the organization's settings. Everybody else on the roster
 * sees what is connected, read-only.
 *
 * Server-only.
 */

import * as core from "@polaris/core";
import { prisma } from "@polaris/db";
import { orgIdsWhere, resolveOrgAccess, type OrgActor } from "@/lib/orgs/org-service";

/** The organization permission that manages its connections. */
export const ORG_CONNECTIONS_PERMISSION: core.OrgPermission = "settings.manage";

/** Whether this actor may connect and remove the organization's accounts. */
export async function managesOrgConnections(actor: OrgActor, orgId: string): Promise<boolean> {
    const access = await resolveOrgAccess(actor, orgId);
    return access !== null && core.hasOrgPermission(access.permissions, ORG_CONNECTIONS_PERMISSION);
}

/** One organization whose connections this actor manages. */
export interface ManagedConnectionOrg {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
}

/** The organizations whose connections this actor manages, by name. */
export async function managedConnectionOrgs(actor: OrgActor): Promise<ManagedConnectionOrg[]> {
    const ids = await orgIdsWhere(actor, ORG_CONNECTIONS_PERMISSION);
    if (ids.length === 0) return [];
    return prisma.organization.findMany({
        where: { id: { in: ids } },
        select: { id: true, slug: true, name: true },
        orderBy: { name: "asc" },
        take: 100
    });
}

/** The actor an account id stands for, read from the account itself. */
export async function orgActorFor(userId: string): Promise<OrgActor> {
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    return { id: userId, isAdmin: user?.isAdmin === true };
}
