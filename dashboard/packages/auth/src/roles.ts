/**
 * Role and permission resolution against the database. better-auth owns the
 * user/session tables; Polaris owns Role/UserRole, so authorization is resolved
 * here by reading a user's roles and folding their permission grants with the
 * pure evaluator from @polaris/core. The first-registered user is bootstrapped
 * as an admin so a fresh install is usable without a seed step.
 */

import { can } from "./authz.js";
import { prisma } from "@polaris/db";
import {
    CHAT_CAPABILITIES,
    DEFAULT_ROLES,
    mergeRolePermissions,
    type GrantedPermission,
    type Permission
} from "@polaris/core";

/** Insert the built-in roles if they are missing. Idempotent. */
export async function seedDefaultRoles(): Promise<void> {
    for (const [name, permissions] of Object.entries(DEFAULT_ROLES)) {
        await prisma.role.upsert({
            where: { name },
            update: {},
            create: { name, permissions: JSON.stringify(permissions), isSystem: true }
        });
    }
    await carryChatCapabilities();
}

/** That the carry-forward below has already happened, so it happens once. */
const CHAT_CARRY_MARK = "roles.chatCapabilitiesCarried";

/**
 * Give the new chat grants to the roles that predate them.
 *
 * `chat.use` used to mean the whole app: servers, groups, attachments and calls
 * came with it. Splitting them out is what makes those decisions available to an
 * operator, and it must not be what takes them away - a role written last month
 * would otherwise silently lose the attach button the morning after an update,
 * which nobody would read as a new setting.
 *
 * Seeding never rewrites an existing role, and this is the one exception:
 * additive, only on roles that already hold the chat, and recorded so it is done
 * once. After it has run, these are ordinary grants an operator turns off like
 * any other - including the ones this added.
 */
async function carryChatCapabilities(): Promise<void> {
    const done = await prisma.setting.findUnique({
        where: { key: CHAT_CARRY_MARK },
        select: { key: true }
    });
    if (done) return;

    const roles = await prisma.role.findMany({ select: { id: true, permissions: true } });
    for (const role of roles) {
        const grants = parseGrants(role.permissions);
        // A role holding the wildcard already holds these, and a role without
        // the chat is not being handed one.
        if (!grants.includes("chat.use")) continue;
        const missing = CHAT_CAPABILITIES.filter((capability) => !grants.includes(capability));
        if (missing.length === 0) continue;
        await prisma.role.update({
            where: { id: role.id },
            data: { permissions: JSON.stringify([...grants, ...missing]) }
        });
    }
    // Upserted rather than created: two callers can reach this at once - the
    // seed runs from several entry points - and the second must not fail on the
    // unique key after doing the same harmless work.
    await prisma.setting.upsert({
        where: { key: CHAT_CARRY_MARK },
        update: {},
        create: { key: CHAT_CARRY_MARK, value: "done" }
    });
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
