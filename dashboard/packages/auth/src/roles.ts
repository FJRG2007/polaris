/**
 * Role and permission resolution against the database. better-auth owns the
 * user/session tables; Polaris owns Role/UserRole, so authorization is resolved
 * here by reading a user's roles and folding their permission grants with the
 * pure evaluator from @polaris/core. The first-registered user is bootstrapped
 * as an admin so a fresh install is usable without a seed step.
 */

import {
    DEFAULT_ROLES,
    mergeRolePermissions,
    type GrantedPermission,
    type Permission
} from "@polaris/core";
import { prisma } from "@polaris/db";
import { can } from "./authz.js";

/** Insert the built-in roles if they are missing. Idempotent. */
export async function seedDefaultRoles(): Promise<void> {
    for (const [name, permissions] of Object.entries(DEFAULT_ROLES)) {
        await prisma.role.upsert({
            where: { name },
            update: {},
            create: { name, permissions: JSON.stringify(permissions), isSystem: true }
        });
    }
}

/** Resolve the full set of permission grants a user holds across all their roles. */
export async function getUserPermissions(userId: string): Promise<Set<GrantedPermission>> {
    const rows = await prisma.userRole.findMany({
        where: { userId },
        select: { role: { select: { permissions: true } } }
    });
    const roleGrants = rows.map((row) => parseGrants(row.role.permissions));
    return mergeRolePermissions(roleGrants);
}

/**
 * True if the user (or an admin) holds the required permission. Delegates to the
 * authorization engine so grants from directly-held roles, group- and
 * role-attached policies, and direct policy attachments are all considered, with
 * an explicit deny in any policy overriding an allow.
 */
export async function userHasPermission(userId: string, required: Permission): Promise<boolean> {
    return can(userId, required);
}

/**
 * Assign a role to a user by role name. Used by the invite-acceptance and admin
 * flows. No-ops if the pairing already exists.
 */
export async function assignRole(userId: string, roleName: string): Promise<void> {
    const role = await prisma.role.findUnique({ where: { name: roleName }, select: { id: true } });
    if (!role) throw new Error(`Unknown role: ${roleName}`);
    await prisma.userRole.upsert({
        where: { userId_roleId: { userId, roleId: role.id } },
        update: {},
        create: { userId, roleId: role.id }
    });
}

/** Parse a stored permissions JSON string into a validated grant array. */
function parseGrants(raw: string): GrantedPermission[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? (parsed as GrantedPermission[]) : [];
    } catch {
        return [];
    }
}
