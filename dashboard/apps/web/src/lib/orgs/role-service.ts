/**
 * The roles one organization defines for itself.
 *
 * An organization is a company, a studio, an agency or a household, and none of
 * them mean the same thing by "admin". So rather than a fixed ladder, each one
 * keeps its own list: a name people recognise, and the set of things holding it
 * lets you do. A membership stores the slug, which is why renaming a role leaves
 * every roster intact.
 *
 * Two are seeded and cannot be deleted - `admin`, which holds the wildcard and
 * cannot be edited either, and `member`, which is where somebody lands when the
 * role they had is removed. Everything else here is the organization's own.
 *
 * Authorization is not decided in this file. It reads and writes the definitions;
 * `resolveOrgAccess` in org-service is what a request is judged against.
 */

import { OrgError } from "./errors";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";

export interface OrgRoleView {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly permissions: string[];
    /** Seeded by Polaris: it cannot be deleted, and `admin` cannot be edited. */
    readonly system: boolean;
    /** How many people hold it, so deleting one can say who it moves. */
    readonly memberCount: number;
}

/**
 * Put the seeded roles back if they are missing.
 *
 * Called before anything that reads or writes a role rather than only at
 * creation: an organization made before this table existed has been migrated, but
 * an instance restored from an older dump has not, and a roster whose roles have
 * no rows is a roster nobody can change. Upsert, so it is safe to call on every
 * path and never overwrites what an organization has since decided `member`
 * should mean.
 */
export async function ensureSystemRoles(orgId: string): Promise<void> {
    const existing = await prisma.orgRole.findMany({
        where: { orgId, slug: { in: [...core.ORG_SYSTEM_ROLE_SLUGS] } },
        select: { slug: true }
    });
    const missing = core.ORG_SYSTEM_ROLE_SLUGS.filter((slug) => !existing.some((role) => role.slug === slug));
    if (missing.length === 0) return;

    await prisma.orgRole.createMany({
        data: missing.map((slug) => {
            // ORG_SYSTEM_ROLE_SLUGS is the key list of ORG_SYSTEM_ROLES, so this
            // is always present; the fallback only satisfies the type.
            const role = core.ORG_SYSTEM_ROLES[slug] ?? { name: slug, description: "", permissions: [] };
            return {
                orgId,
                slug,
                name: role.name,
                description: role.description,
                permissions: JSON.stringify(role.permissions),
                system: true
            };
        }),
        skipDuplicates: true
    });
}

/** Every role this organization has, seeded ones first and then by name, with
 *  the number of people holding each. */
export async function listOrgRoles(orgId: string): Promise<OrgRoleView[]> {
    await ensureSystemRoles(orgId);
    const [roles, counts] = await Promise.all([
        prisma.orgRole.findMany({ where: { orgId }, orderBy: { name: "asc" } }),
        prisma.organizationMember.groupBy({ by: ["role"], where: { orgId }, _count: { role: true } })
    ]);
    const held = new Map(counts.map((row) => [row.role, row._count.role]));

    return roles
        .map((role) => ({
            id: role.id,
            slug: role.slug,
            name: role.name,
            description: role.description,
            permissions: parsePermissions(role.permissions),
            system: role.system,
            memberCount: held.get(role.slug) ?? 0
        }))
        .sort((left, right) => Number(right.system) - Number(left.system) || left.name.localeCompare(right.name));
}

/** Stored as JSON so one column carries the set. Anything unreadable grants
 *  nothing, which is the safe direction for a permission list. */
function parsePermissions(raw: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
        return [];
    }
}

export async function createOrgRole(orgId: string, input: core.OrgRoleInput): Promise<string> {
    await ensureSystemRoles(orgId);
    const clash = await prisma.orgRole.findUnique({
        where: { orgId_slug: { orgId, slug: input.slug } },
        select: { id: true }
    });
    if (clash) throw new OrgError("This organization already has a role with that handle");

    const role = await prisma.orgRole.create({
        data: {
            orgId,
            slug: input.slug,
            name: input.name,
            description: input.description,
            permissions: JSON.stringify(input.permissions)
        },
        select: { id: true }
    });
    return role.id;
}

/**
 * Rewrite a role.
 *
 * The handle does not move: a membership names it, and renaming the slug under a
 * roster would silently reassign everybody holding it. `admin` is refused
 * outright - it holds the wildcard, so an edit could only ever narrow the one
 * role that exists to be unrestricted, and an organization that locked itself out
 * of its own settings has no way back that does not involve the operator.
 */
export async function updateOrgRole(
    orgId: string,
    slug: string,
    input: Pick<core.OrgRoleInput, "name" | "description" | "permissions">
): Promise<void> {
    if (slug === core.UNEDITABLE_ORG_ROLE) throw new OrgError("The Admin role cannot be changed");
    const role = await prisma.orgRole.findUnique({ where: { orgId_slug: { orgId, slug } }, select: { id: true } });
    if (!role) throw new OrgError("That role no longer exists");

    await prisma.orgRole.update({
        where: { id: role.id },
        data: {
            name: input.name,
            description: input.description,
            permissions: JSON.stringify(input.permissions)
        }
    });
}

/**
 * Remove a role, and move whoever held it.
 *
 * Everybody lands on `member` in the same transaction, because a membership
 * naming a role that no longer exists would fall back to whatever that slug used
 * to mean - which is precisely the kind of quiet grant nobody would find again. A
 * seeded role is refused: `member` is where this lands people, and `admin` is the
 * way back into an organization that has been misconfigured.
 */
export async function deleteOrgRole(orgId: string, slug: string): Promise<void> {
    const role = await prisma.orgRole.findUnique({
        where: { orgId_slug: { orgId, slug } },
        select: { id: true, system: true }
    });
    if (!role) throw new OrgError("That role no longer exists");
    if (role.system) throw new OrgError("The roles Polaris seeds cannot be deleted");

    await ensureSystemRoles(orgId);
    await prisma.$transaction([
        prisma.organizationMember.updateMany({
            where: { orgId, role: slug },
            data: { role: core.DEFAULT_ORG_ROLE }
        }),
        prisma.orgRole.delete({ where: { id: role.id } })
    ]);
}
