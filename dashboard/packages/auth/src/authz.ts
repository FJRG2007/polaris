/**
 * The authorization decision point for global capabilities. A user's effective
 * permissions come from three sources folded into one statement list: the roles
 * they hold (each role permission becomes an allow over every resource), and the
 * policies attached to them, their groups, and their roles. The pure engine in
 * @polaris/core then resolves the request with deny-by-default and
 * explicit-deny-override. Admins short-circuit to allow.
 *
 * Per-file Drive access is a separate, resource-scoped decision that also needs
 * ownership and ACL rows from the web app's database context, so it is composed
 * there; this module exposes the reusable pieces (statement resolution) it builds
 * on. Global role permissions are intentionally NOT drive-resource grants: they
 * gate whether the Drive feature is usable, not which connections can be read.
 */

import { ALL_PERMISSIONS, isAllowed, type PolicyStatement, type Permission } from "@polaris/core";
import { prisma } from "@polaris/db";
import { resolvePrincipalPolicyStatements } from "./policies.js";

/** A sentinel resource for global (non-resource-scoped) capability checks. */
const GLOBAL_RESOURCE = "*";

/** Compile a user's role permissions into allow-everywhere statements. */
async function roleStatements(userId: string): Promise<PolicyStatement[]> {
    const rows = await prisma.userRole.findMany({
        where: { userId },
        select: { role: { select: { permissions: true } } }
    });
    const statements: PolicyStatement[] = [];
    for (const row of rows) {
        let keys: string[] = [];
        try {
            const parsed = JSON.parse(row.role.permissions);
            if (Array.isArray(parsed)) keys = parsed.filter((value): value is string => typeof value === "string");
        } catch {
            keys = [];
        }
        for (const key of keys) {
            statements.push({ effect: "allow", actions: [key], resources: ["*"] });
        }
    }
    return statements;
}

/**
 * The full set of statements that decide a user's global capabilities: their role
 * grants plus every policy attached to them, their groups, and their roles.
 */
export async function resolveGlobalStatements(userId: string): Promise<PolicyStatement[]> {
    const [roles, policies] = await Promise.all([
        roleStatements(userId),
        resolvePrincipalPolicyStatements(userId)
    ]);
    return [...roles, ...policies];
}

/** Whether a user holds a global capability. Admins are allowed everything. */
export async function can(userId: string, permission: Permission | typeof ALL_PERMISSIONS): Promise<boolean> {
    const admin = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (admin?.isAdmin) return true;
    const statements = await resolveGlobalStatements(userId);
    return isAllowed(statements, permission, GLOBAL_RESOURCE);
}

/**
 * Everyone who currently holds a capability - the question a broadcast asks,
 * where every other check asks about one user.
 *
 * It cannot be a query. Role grants and policy documents are stored as JSON, and
 * a deny in a policy can take back what a role gave, so the only honest answer
 * runs each candidate through the same decision point a request would take. A
 * banned account is not a candidate: it cannot act on what it would be told.
 *
 * Meant for the rare fan-out (an update to announce), not for a request path.
 */
export async function usersWithPermission(permission: Permission): Promise<string[]> {
    const users = await prisma.user.findMany({ where: { bannedAt: null }, select: { id: true } });
    const decisions = await Promise.all(
        users.map(async (user) => ((await can(user.id, permission)) ? user.id : null))
    );
    return decisions.filter((id): id is string => id !== null);
}
