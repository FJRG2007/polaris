/**
 * Roles, and what each one is allowed to do. A role is a named bundle of
 * permissions; accounts hold one, and every capability check across Polaris
 * resolves through it.
 *
 * Polaris seeds a few (admin, member, viewer, guest) but never rewrites one that
 * already exists, so what a member may do on this instance is whatever an
 * operator last saved here rather than a constant in the source. Two roles are
 * special and say so on the row: `admin` holds the wildcard and cannot be edited
 * into something narrower, and no seeded role can be deleted, because an invite,
 * a policy, or an account may still point at it.
 *
 * Grants are stored expanded - picking "delete files" writes "see files" down
 * with it - so what a role holds always reads in full, and the evaluator never
 * has to infer.
 */

import { prisma } from "@polaris/db";
import { seedDefaultRoles } from "@polaris/auth";
import { recordAudit } from "@/lib/audit-service";
import {
    ALL_PERMISSIONS,
    expandPermissions,
    PERMISSIONS,
    SYSTEM_ROLES,
    UNEDITABLE_ROLE,
    type CreateRoleInput,
    type Permission
} from "@polaris/core";

/** One role, as the editor reads it. */
export interface RoleView {
    id: string;
    name: string;
    /** Seeded by Polaris: rewritable, but never deletable. */
    isSystem: boolean;
    /** Holds every permission there is and every one added later. */
    wildcard: boolean;
    permissions: Permission[];
    /** How many accounts currently hold it. */
    memberCount: number;
}

/** Parse a stored grant list, tolerating a row written by an older version. */
function readGrants(raw: string): { wildcard: boolean; permissions: Permission[] } {
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch {
        return { wildcard: false, permissions: [] };
    }
    if (!Array.isArray(parsed)) return { wildcard: false, permissions: [] };
    const keys = parsed.filter((value): value is string => typeof value === "string");
    return {
        wildcard: keys.includes(ALL_PERMISSIONS),
        permissions: expandPermissions(keys.filter((key) => key !== ALL_PERMISSIONS) as Permission[])
    };
}

/** Every role, with what it grants and how many people hold it. */
export async function listRoles(): Promise<RoleView[]> {
    await seedDefaultRoles();
    const rows = await prisma.role.findMany({
        orderBy: { name: "asc" },
        select: { id: true, name: true, isSystem: true, permissions: true, _count: { select: { users: true } } }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        isSystem: row.isSystem || SYSTEM_ROLES.includes(row.name),
        ...readGrants(row.permissions),
        memberCount: row._count.users
    }));
}

/** A role as the pickers offer it: its name, and whether it opens anything at
 *  all - the difference between handing somebody the platform and handing them
 *  an account that only proves who they are. */
export interface RoleOption {
    name: string;
    grants: number;
}

export async function listRoleOptions(): Promise<RoleOption[]> {
    await seedDefaultRoles();
    const rows = await prisma.role.findMany({ orderBy: { name: "asc" }, select: { name: true, permissions: true } });
    return rows.map((row) => {
        const { wildcard, permissions } = readGrants(row.permissions);
        return { name: row.name, grants: wildcard ? PERMISSIONS.length : permissions.length };
    });
}

export async function createRole(actorId: string, input: CreateRoleInput): Promise<{ id?: string; error?: string }> {
    const name = input.name.trim().toLowerCase();
    if (await prisma.role.findUnique({ where: { name }, select: { id: true } })) {
        return { error: "A role with that name already exists." };
    }
    const permissions = expandPermissions(input.permissions);
    const role = await prisma.role.create({
        data: { name, permissions: JSON.stringify(permissions), isSystem: false },
        select: { id: true }
    });
    await recordAudit({
        actorId,
        action: "role.create",
        targetType: "role",
        targetId: role.id,
        metadata: { name, permissions: permissions.length }
    });
    return { id: role.id };
}

/** Rewrite what a role grants. The wildcard role is refused: narrowing the one
 *  role that exists to be unrestricted is never what was meant. */
export async function setRolePermissions(
    actorId: string,
    roleId: string,
    permissions: Permission[]
): Promise<{ error?: string }> {
    const role = await prisma.role.findUnique({ where: { id: roleId }, select: { name: true } });
    if (!role) return { error: "Unknown role." };
    if (role.name === UNEDITABLE_ROLE) return { error: "The administrator role always holds everything." };

    const expanded = expandPermissions(permissions);
    await prisma.role.update({ where: { id: roleId }, data: { permissions: JSON.stringify(expanded) } });
    await recordAudit({
        actorId,
        action: "role.permissions",
        targetType: "role",
        targetId: roleId,
        metadata: { name: role.name, permissions: expanded }
    });
    return {};
}

/**
 * Remove a role nobody is using. A role still held by an account, or promised by
 * an open invite, is refused rather than silently taking their access with it -
 * the operator moves those people first, and can see how many there are.
 */
export async function deleteRole(actorId: string, roleId: string): Promise<{ error?: string }> {
    const role = await prisma.role.findUnique({
        where: { id: roleId },
        select: { name: true, isSystem: true, _count: { select: { users: true } } }
    });
    if (!role) return { error: "Unknown role." };
    if (role.isSystem || SYSTEM_ROLES.includes(role.name)) return { error: "Built-in roles cannot be deleted." };
    if (role._count.users > 0) {
        const people = role._count.users === 1 ? "1 person still holds" : `${role._count.users} people still hold`;
        return { error: `${people} this role. Move them to another one first.` };
    }
    const pending = await prisma.invite.count({ where: { roleId, acceptedAt: null } });
    if (pending > 0) return { error: "An open invite still hands out this role. Revoke it first." };

    await prisma.role.delete({ where: { id: roleId } });
    await recordAudit({
        actorId,
        action: "role.delete",
        targetType: "role",
        targetId: roleId,
        metadata: { name: role.name }
    });
    return {};
}
