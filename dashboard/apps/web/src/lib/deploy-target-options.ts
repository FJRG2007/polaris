/**
 * Deploy servers and services a picker offers, a page at a time, filtered and
 * ordered in the database.
 *
 * Each list is scoped exactly as the action that uses the pick checks it, and
 * ordered by name then id, so the cursor - the last row's pair - names where the
 * next page starts and a row added mid-scroll is neither shown twice nor skipped.
 */

import { prisma, type Prisma } from "@polaris/db";
import { scopedProjectWhere } from "@/lib/deploy-service";
import { polarisProjectIds } from "@/lib/deploy/managed-projects";
import { decodeServerCursor, encodeServerCursor } from "@/lib/server-options";
import type {
    DeployTargetOption,
    DeployTargetScope,
    ServiceOption,
    TemplateEnvironmentOption,
    TemplateProjectOption
} from "@/lib/deploy-target-options-schema";

export interface OptionsPage<T> {
    readonly items: T[];
    readonly next: string | null;
}

export interface PageRequest {
    readonly query: string;
    readonly cursor: string | null;
    readonly limit: number;
    readonly ids?: readonly string[];
}

/** Rows after the cursor in (name, id) order, or nothing for the first page. */
export function afterCursor(cursor: string | null) {
    const after = decodeServerCursor(cursor);
    return after
        ? [{ OR: [{ name: { gt: after.name } }, { name: after.name, id: { gt: after.id } }] }]
        : [];
}

export function pageOf<R extends { id: string; name: string }, T>(
    rows: R[],
    limit: number,
    map: (row: R) => T
): OptionsPage<T> {
    const page = rows.slice(0, limit);
    const last = page[page.length - 1];
    return {
        items: page.map(map),
        next: rows.length > limit && last ? encodeServerCursor(last.name, last.id) : null
    };
}

/** The deploy servers a scope offers: exactly what `createTunnel`, the backup
 *  relay (`relayTarget`) and moving a service home (`moveHome`) each accept.
 *  For `project` the caller is the project's owner, resolved by the action. */
export function deployTargetScopeWhere(
    callerId: string,
    scope: DeployTargetScope
): Prisma.DeployTargetWhereInput {
    if (scope === "relay") {
        return { status: "active", kind: { not: "local" }, owner: { isAdmin: true } };
    }
    if (scope === "project") return { ownerId: callerId };
    return { ownerId: callerId, status: "active" };
}

export async function readDeployTargetOptions(
    callerId: string,
    scope: DeployTargetScope,
    request: PageRequest
): Promise<OptionsPage<DeployTargetOption>> {
    const and: Prisma.DeployTargetWhereInput[] = [deployTargetScopeWhere(callerId, scope)];
    if (request.ids) and.push({ id: { in: [...request.ids] } });
    if (request.query) and.push({ name: { contains: request.query, mode: "insensitive" } });
    and.push(...afterCursor(request.cursor));
    const rows = await prisma.deployTarget.findMany({
        where: { AND: and },
        select: { id: true, name: true, kind: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        // One past the page: the extra row is how the end is known without counting.
        take: request.limit + 1
    });
    return pageOf(rows, request.limit, (row) => ({
        id: row.id,
        name: row.name,
        local: row.kind === "local"
    }));
}

/** The owner's services, scoped as `createTunnel` reads the one picked. */
export async function readServiceOptions(
    ownerId: string,
    request: PageRequest & { readonly excludeTargetId?: string }
): Promise<OptionsPage<ServiceOption>> {
    // Polaris's own services (the Marketplace project, the mail server's) are not
    // the owner's to point a tunnel at.
    const hidden = [...(await polarisProjectIds())];
    const and: Prisma.ApplicationWhereInput[] = [
        { environment: { project: hidden.length ? { ownerId, id: { notIn: hidden } } : { ownerId } } }
    ];
    if (request.ids) and.push({ id: { in: [...request.ids] } });
    if (request.excludeTargetId) and.push({ targetId: { not: request.excludeTargetId } });
    if (request.query) {
        and.push({
            OR: [
                { name: { contains: request.query, mode: "insensitive" } },
                {
                    environment: {
                        project: { name: { contains: request.query, mode: "insensitive" } }
                    }
                }
            ]
        });
    }
    and.push(...afterCursor(request.cursor));
    const rows = await prisma.application.findMany({
        where: { AND: and },
        select: {
            id: true,
            name: true,
            targetId: true,
            environment: { select: { project: { select: { name: true } } } }
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: request.limit + 1
    });
    return pageOf(rows, request.limit, (row) => ({
        id: row.id,
        name: row.name,
        project: row.environment.project.name,
        targetId: row.targetId
    }));
}

/** The projects on the open shelf a template can go into - what
 *  `listTemplateTargetsAction` used to read whole - with the environment each
 *  lands in unless another is picked. */
export async function readTemplateProjectOptions(
    userId: string,
    orgId: string | null,
    request: PageRequest
): Promise<OptionsPage<TemplateProjectOption>> {
    const and: Prisma.ProjectWhereInput[] = [
        (await scopedProjectWhere(userId, orgId)) as Prisma.ProjectWhereInput
    ];
    // A template never lands in a project Polaris runs for its own apps.
    const hidden = [...(await polarisProjectIds())];
    if (hidden.length) and.push({ id: { notIn: hidden } });
    if (request.ids) and.push({ id: { in: [...request.ids] } });
    if (request.query) and.push({ name: { contains: request.query, mode: "insensitive" } });
    and.push(...afterCursor(request.cursor));
    const rows = await prisma.project.findMany({
        where: { AND: and },
        select: {
            id: true,
            name: true,
            environments: {
                select: { id: true },
                orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
                // The default, and whether there is a second to choose.
                take: 2
            }
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: request.limit + 1
    });
    return pageOf(rows, request.limit, (row) => ({
        id: row.id,
        name: row.name,
        environmentId: row.environments[0]?.id ?? null,
        manyEnvironments: row.environments.length > 1
    }));
}

/** The environments of one of those projects - nothing for a project the caller
 *  could not have picked. */
export async function readTemplateEnvironmentOptions(
    userId: string,
    orgId: string | null,
    projectId: string,
    request: PageRequest
): Promise<OptionsPage<TemplateEnvironmentOption>> {
    const and: Prisma.EnvironmentWhereInput[] = [
        {
            projectId,
            project: (await scopedProjectWhere(userId, orgId)) as Prisma.ProjectWhereInput
        }
    ];
    if (request.ids) and.push({ id: { in: [...request.ids] } });
    if (request.query) and.push({ name: { contains: request.query, mode: "insensitive" } });
    and.push(...afterCursor(request.cursor));
    const rows = await prisma.environment.findMany({
        where: { AND: and },
        select: { id: true, name: true },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take: request.limit + 1
    });
    return pageOf(rows, request.limit, (row) => row);
}
