/**
 * Role and permission resolution against the database. better-auth owns the
 * user/session tables; Polaris owns Role/UserRole, so authorization is resolved
 * here by reading a user's roles and folding their permission grants with the
 * pure evaluator from @polaris/core. The first-registered user is bootstrapped
 * as an admin so a fresh install is usable without a seed step.
 */

import {
    DEFAULT_ROLES,
    hasPermission,
    mergeRolePermissions,
    type GrantedPermission,
    type Permission
} from "@polaris/core";
import { prisma } from "@polaris/db";

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

/** True if the user (or an admin) holds the required permission. */
export async function userHasPermission(userId: string, required: Permission): Promise<boolean> {
    const admin = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (admin?.isAdmin) return true;
    return hasPermission(await getUserPermissions(userId), required);
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
