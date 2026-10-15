/**
 * Variable groups: named sets of variables on a shelf (somebody's own, or one
 * organization's) that services in any project on that shelf can link.
 *
 * The variables themselves are EnvVar rows with scopeType "group", so they are
 * written, sealed, revealed and restored by env-var-service exactly as a
 * service's are. This module owns the group rows, who may do what with them,
 * the links, and the layers a linked service's environment is built from.
 *
 * Who may do what:
 * - A personal group is its owner's alone: only they read, edit or link it.
 * - An organization's group is read (names, plain values, linking) by any of
 *   its members, and edited - secrets revealed included - by
 *   anyone holding deploy.manage there.
 * - A service links only a group on its own project's shelf (groupFitsProject),
 *   so a group's values never reach a project run by people outside its circle.
 */

import { prisma } from "@polaris/db";
import { z } from "zod";
import * as core from "@polaris/core";
import { decryptedValue } from "./env-values";
import { requireApplicationAccess, requireEnvScopeAccess } from "@/lib/deploy-project-access";
import { orgCan, resolveOrgAccess, type OrgActor } from "@/lib/orgs/org-service";

export type GroupNeed = "read" | "edit";

export interface GroupRights {
    readonly id: string;
    readonly ownerId: string;
    readonly orgId: string | null;
    readonly name: string;
    readonly canRead: boolean;
    readonly canEdit: boolean;
}

/** Thrown for anything the caller may say on screen as it is. */
export class VariableGroupError extends Error {
    constructor(readonly code: "notFound" | "readOnly" | "otherShelf" | "tooMany" | "taken") {
        super(code);
        this.name = "VariableGroupError";
    }
}

/** What this actor may do with a group on this shelf. */
async function rightsOn(
    actor: OrgActor,
    shelf: { ownerId: string; orgId: string | null }
): Promise<{ canRead: boolean; canEdit: boolean }> {
    if (shelf.orgId === null) {
        const mine = shelf.ownerId === actor.id;
        return { canRead: mine, canEdit: mine };
    }
    const access = await resolveOrgAccess(actor, shelf.orgId);
    const canEdit = orgCan(access, "deploy.manage");
    // Belonging to the organization is what reads its Deploy shelf (the
    // instance's deploy.read is required of every caller before this).
    return { canRead: canEdit || access !== null, canEdit };
}

/** The group with what this actor may do with it, or null when it is gone or
 *  not theirs to see - the two are answered alike, so a stranger learns nothing. */
export async function groupRights(actor: OrgActor, groupId: string): Promise<GroupRights | null> {
    const group = await prisma.variableGroup.findUnique({
        where: { id: groupId },
        select: { id: true, ownerId: true, orgId: true, name: true }
    });
    if (!group) return null;
    const rights = await rightsOn(actor, group);
    if (!rights.canRead) return null;
    return { ...group, ...rights };
}

/** The same, refused unless the actor holds what is needed. */
export async function requireGroup(
    actor: OrgActor,
    groupId: string,
    need: GroupNeed
): Promise<GroupRights> {
    const rights = await groupRights(actor, groupId);
    if (!rights) throw new VariableGroupError("notFound");
    if (need === "edit" && !rights.canEdit) throw new VariableGroupError("readOnly");
    return rights;
}

export interface VariableGroupSummary {
    id: string;
    name: string;
    description: string;
    variableCount: number;
    linkCount: number;
    canEdit: boolean;
    updatedAt: string;
}

/** Every group on one shelf this actor may read, newest change first. */
export async function listGroups(
    actor: OrgActor,
    orgId: string | null
): Promise<{ groups: VariableGroupSummary[]; canCreate: boolean }> {
    const rights = await rightsOn(actor, { ownerId: actor.id, orgId });
    if (!rights.canRead) return { groups: [], canCreate: false };
    const rows = await prisma.variableGroup.findMany({
        where: orgId === null ? { ownerId: actor.id, orgId: null } : { orgId },
        orderBy: { updatedAt: "desc" },
        take: 200,
        select: {
            id: true,
            name: true,
            description: true,
            updatedAt: true,
            _count: { select: { links: true } }
        }
    });
    const counts =
        rows.length === 0
            ? []
            : await prisma.envVar.groupBy({
                  by: ["scopeId"],
                  where: { scopeType: "group", scopeId: { in: rows.map((row) => row.id) } },
                  _count: { _all: true }
              });
    const byGroup = new Map(counts.map((row) => [row.scopeId, row._count._all]));
    return {
        canCreate: rights.canEdit,
        groups: rows.map((row) => ({
            id: row.id,
            name: row.name,
            description: row.description,
            variableCount: byGroup.get(row.id) ?? 0,
            linkCount: row._count.links,
            canEdit: rights.canEdit,
            updatedAt: row.updatedAt.toISOString()
        }))
    };
}

/** Make a group on a shelf the actor may edit. Names are unique per shelf. */
export async function createGroup(
    actor: OrgActor,
    orgId: string | null,
    input: core.VariableGroupInput
): Promise<{ id: string }> {
    const rights = await rightsOn(actor, { ownerId: actor.id, orgId });
    if (!rights.canEdit) throw new VariableGroupError("readOnly");
    await assertNameFree(actor.id, orgId, input.name, null);
    const created = await prisma.variableGroup.create({
        data: {
            ownerId: actor.id,
            orgId,
            name: input.name,
            description: input.description,
            createdById: actor.id
        },
        select: { id: true }
    });
    return created;
}

async function assertNameFree(
    ownerId: string,
    orgId: string | null,
    name: string,
    exceptId: string | null
): Promise<void> {
    const clash = await prisma.variableGroup.findFirst({
        where: {
            ...(orgId === null ? { ownerId, orgId: null } : { orgId }),
            name: { equals: name, mode: "insensitive" },
            ...(exceptId ? { id: { not: exceptId } } : {})
        },
        select: { id: true }
    });
    if (clash) throw new VariableGroupError("taken");
}

export async function updateGroup(
    actor: OrgActor,
    groupId: string,
    input: core.VariableGroupInput
): Promise<void> {
    const group = await requireGroup(actor, groupId, "edit");
    await assertNameFree(group.ownerId, group.orgId, input.name, group.id);
    await prisma.variableGroup.update({
        where: { id: group.id },
        data: { name: input.name, description: input.description }
    });
}

/** Remove a group, its variables and every link to it, in one transaction.
 *  Answers the services that read it, so the caller can say what changed. */
export async function deleteGroup(actor: OrgActor, groupId: string): Promise<{ linked: number }> {
    const group = await requireGroup(actor, groupId, "edit");
    const linked = await prisma.variableGroupLink.count({ where: { groupId: group.id } });
    await prisma.$transaction([
        prisma.envVar.deleteMany({ where: { scopeType: "group", scopeId: group.id } }),
        prisma.variableGroup.delete({ where: { id: group.id } })
    ]);
    return { linked };
}

/** Bump the group's updatedAt after its variables changed, so the list orders
 *  by real activity. */
export async function touchGroup(groupId: string): Promise<void> {
    await prisma.variableGroup.update({ where: { id: groupId }, data: { updatedAt: new Date() } });
}

export interface LinkedGroupView {
    id: string;
    name: string;
    position: number;
    /** Names only - never a value. */
    keys: Array<{ key: string; isSecret: boolean }>;
    canEdit: boolean;
}

/** The groups one service links, in the order they are layered. Any project
 *  reader may see their names and keys; values stay behind the group's rights. */
export async function linkedGroups(actor: OrgActor, applicationId: string): Promise<LinkedGroupView[]> {
    const links = await prisma.variableGroupLink.findMany({
        where: { applicationId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { position: true, group: { select: { id: true, name: true, ownerId: true, orgId: true } } }
    });
    if (links.length === 0) return [];
    const keys = await prisma.envVar.findMany({
        where: { scopeType: "group", scopeId: { in: links.map((link) => link.group.id) } },
        orderBy: { key: "asc" },
        select: { scopeId: true, key: true, isSecret: true }
    });
    const views: LinkedGroupView[] = [];
    for (const link of links) {
        const rights = await rightsOn(actor, link.group);
        views.push({
            id: link.group.id,
            name: link.group.name,
            position: link.position,
            keys: keys
                .filter((row) => row.scopeId === link.group.id)
                .map((row) => ({ key: row.key, isSecret: row.isSecret })),
            canEdit: rights.canEdit
        });
    }
    return views;
}

/** The project shelf one service sits on. */
async function serviceShelf(applicationId: string): Promise<{ ownerId: string; orgId: string | null }> {
    const app = await prisma.application.findUnique({
        where: { id: applicationId },
        select: { environment: { select: { project: { select: { ownerId: true, orgId: true } } } } }
    });
    if (!app) throw new VariableGroupError("notFound");
    return app.environment.project;
}

/** Groups this actor could link to the service: on its project's shelf, readable
 *  by them, and not linked yet. */
export async function linkableGroups(
    actor: OrgActor,
    applicationId: string
): Promise<Array<{ id: string; name: string }>> {
    const shelf = await serviceShelf(applicationId);
    const rights = await rightsOn(actor, { ownerId: shelf.orgId === null ? shelf.ownerId : actor.id, orgId: shelf.orgId });
    if (!rights.canRead) return [];
    return prisma.variableGroup.findMany({
        where: {
            ...(shelf.orgId === null ? { ownerId: shelf.ownerId, orgId: null } : { orgId: shelf.orgId }),
            links: { none: { applicationId } }
        },
        orderBy: { name: "asc" },
        take: 200,
        select: { id: true, name: true }
    });
}

/**
 * Link a group to a service, layered above the groups it already links. The
 * caller has already checked the right to change the service's variables;
 * this refuses a group the actor cannot read or one off the project's shelf.
 */
export async function linkGroup(actor: OrgActor, applicationId: string, groupId: string): Promise<void> {
    const group = await requireGroup(actor, groupId, "read");
    const shelf = await serviceShelf(applicationId);
    if (!core.groupFitsProject(group, shelf)) throw new VariableGroupError("otherShelf");
    const existing = await prisma.variableGroupLink.findMany({
        where: { applicationId },
        select: { groupId: true, position: true }
    });
    if (existing.some((one) => one.groupId === groupId)) return;
    if (existing.length >= core.VARIABLE_GROUP_LINKS_MAX) throw new VariableGroupError("tooMany");
    const position = existing.reduce((max, one) => Math.max(max, one.position + 1), 0);
    await prisma.variableGroupLink.upsert({
        where: { groupId_applicationId: { groupId, applicationId } },
        create: { groupId, applicationId, position, createdById: actor.id },
        update: {}
    });
}

export async function unlinkGroup(applicationId: string, groupId: string): Promise<void> {
    await prisma.variableGroupLink.deleteMany({ where: { applicationId, groupId } });
}

/** Every linked group's variables decrypted, as layers in link order. For the
 *  deploy pipeline only - nothing here reaches a screen. */
export async function groupLayers(applicationId: string): Promise<core.VariableLayer[]> {
    const links = await prisma.variableGroupLink.findMany({
        where: { applicationId },
        orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        select: { group: { select: { id: true, name: true } } }
    });
    if (links.length === 0) return [];
    const rows = await prisma.envVar.findMany({
        where: { scopeType: "group", scopeId: { in: links.map((link) => link.group.id) } }
    });
    return links.map((link) => {
        const values: Record<string, string> = {};
        for (const row of rows) {
            if (row.scopeId !== link.group.id) continue;
            const value = decryptedValue(row);
            if (value !== null) values[row.key] = value;
        }
        return { source: { kind: "group", id: link.group.id, name: link.group.name }, values };
    });
}

/** The deployed services that link a group: what a change to it reaches. */
export async function deployedServicesLinking(groupId: string): Promise<string[]> {
    const rows = await prisma.variableGroupLink.findMany({
        where: { groupId, application: { currentDeploymentId: { not: null }, binnedAt: null } },
        select: { applicationId: true }
    });
    return rows.map((row) => row.applicationId);
}

/**
 * Restart every deployed service linking the group that this actor may deploy,
 * with the variables as they now are. Services they may not deploy are left
 * alone and counted, so the screen can say how many were skipped.
 */
export async function redeployLinked(
    actor: OrgActor,
    groupId: string,
    restart: (applicationId: string, ownerId: string) => Promise<void>
): Promise<{ started: number; skipped: number }> {
    let started = 0;
    let skipped = 0;
    for (const applicationId of await deployedServicesLinking(groupId)) {
        const access = await requireApplicationAccess(applicationId, actor.id, "deploy.run").catch(
            () => null
        );
        if (!access) {
            skipped += 1;
            continue;
        }
        await restart(applicationId, access.ownerId).catch(() => undefined);
        started += 1;
    }
    return { started, skipped };
}

/**
 * Access to any variable scope - a service, an environment, or a group - as
 * the owner whose rows the caller then acts on, and the organization to name
 * in the audit. A service or environment is the project's capability; a group
 * maps reading onto its read right and anything else (writing, revealing a
 * secret, redeploying from it) onto its edit right.
 */
export async function requireVariableScopeAccess(
    scope: "application" | "environment" | "group",
    scopeId: string,
    actor: OrgActor,
    capability: core.ProjectCapability,
    options: { reveal?: boolean } = {}
): Promise<{ ownerId: string; orgId: string | null }> {
    if (scope !== "group") {
        const access = await requireEnvScopeAccess(scope, scopeId, actor.id, capability);
        return { ownerId: access.ownerId, orgId: access.orgId };
    }
    const need: GroupNeed = capability === "variables.read" && !options.reveal ? "read" : "edit";
    const group = await requireGroup(actor, scopeId, need).catch((caught: unknown) => {
        // Said the way every other scope says it, so a caller's message reads alike.
        throw caught instanceof VariableGroupError && caught.code === "readOnly"
            ? new Error("You cannot change this variable group")
            : new Error("Variable group not found");
    });
    return { ownerId: group.ownerId, orgId: group.orgId };
}

/** A variable scope as a caller hands it in. */
export const variableScopeSchema = z.object({
    scope: z.enum(["application", "environment", "group"]),
    scopeId: z.string().trim().min(1).max(100)
});

/** What an audit entry about a scope's variables names as its target. */
export function variableTargetType(scope: "application" | "environment" | "group"): string {
    return scope === "group" ? "variable-group" : scope;
}
