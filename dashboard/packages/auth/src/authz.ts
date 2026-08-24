/**
 * The authorization decision point for global capabilities. A user's effective
 * permissions come from three sources folded into one statement list: the roles
 * they hold (each role permission becomes an allow over every resource), the
 * policies attached to them, their groups, and their roles, and the overrides
 * set on the account itself. The pure engine in @polaris/core then resolves the
 * request with deny-by-default and explicit-deny-override. Admins short-circuit
 * to allow.
 *
 * Per-file Drive access is a separate, resource-scoped decision that also needs
 * ownership and ACL rows from the web app's database context, so it is composed
 * there; this module exposes the reusable pieces (statement resolution) it builds
 * on. Global role permissions are intentionally NOT drive-resource grants: they
 * gate whether the Drive feature is usable, not which connections can be read.
 */

import { prisma, VISIBLE_USER } from "@polaris/db";
import {
    resolvePrincipalPolicyStatements,
    resolvePrincipalPolicyStatementsBySource,
    type PrincipalType
} from "./policies.js";
import { holdsAnyGrantCarrying, resourceGrantStatements } from "./resource-grants.js";
import {
    ALL_PERMISSIONS,
    evaluateStatements,
    isAllowed,
    resourceString,
    type Permission,
    type PolicyStatement,
    type ResourceRef
} from "@polaris/core";

/** A sentinel resource for global (non-resource-scoped) capability checks. */
const GLOBAL_RESOURCE = "*";

/** A role's stored grant list. Malformed JSON grants nothing. */
function parseRoleGrants(raw: string): string[] {
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
    } catch {
        return [];
    }
}

/** Compile a user's role permissions into allow-everywhere statements. */
async function roleStatements(userId: string): Promise<PolicyStatement[]> {
    const rows = await prisma.userRole.findMany({
        where: { userId },
        select: { role: { select: { permissions: true } } }
    });
    return rows.flatMap((row) =>
        parseRoleGrants(row.role.permissions).map((key) => ({
            effect: "allow" as const,
            actions: [key],
            resources: ["*"]
        }))
    );
}

/**
 * One capability switched on or off for one account, as statements.
 *
 * Last in the list it is folded into, which changes nothing about the outcome -
 * the engine resolves deny-over-allow regardless of order - and everything about
 * reading it: an override is the exception written on top of the rules, and it
 * reads that way in a list too.
 */
async function overrideStatements(userId: string): Promise<PolicyStatement[]> {
    const rows = await prisma.userPermission.findMany({
        where: { userId },
        select: { permission: true, effect: true }
    });
    return rows.map((row) => ({
        effect: row.effect === "deny" ? ("deny" as const) : ("allow" as const),
        actions: [row.permission],
        resources: ["*"]
    }));
}

/**
 * The full set of statements that decide a user's global capabilities: their role
 * grants, every policy attached to them, their groups and their roles, and the
 * overrides set on the account itself.
 */
export async function resolveGlobalStatements(userId: string): Promise<PolicyStatement[]> {
    const [roles, policies, overrides] = await Promise.all([
        roleStatements(userId),
        resolvePrincipalPolicyStatements(userId),
        overrideStatements(userId)
    ]);
    return [...roles, ...policies, ...overrides];
}

/** Where a statement came from, for the screen that has to explain an answer
 *  rather than only give one. */
export type StatementSource =
    | { readonly kind: "role"; readonly id: string; readonly name: string }
    /** Set on the account itself, from their profile. */
    | { readonly kind: "account"; readonly id: string; readonly name: string }
    | {
          readonly kind: "policy";
          readonly id: string;
          readonly name: string;
          readonly principalType: PrincipalType;
          readonly principalId: string;
      };

export interface SourcedStatements {
    readonly source: StatementSource;
    readonly statements: PolicyStatement[];
}

/**
 * The same statements, still attributed.
 *
 * `resolveGlobalStatements` is a flatten of this. Kept as one resolution rather
 * than two so an explanation of somebody's access can never say something the
 * decision would not.
 */
export async function resolveGlobalStatementsBySource(userId: string): Promise<SourcedStatements[]> {
    const [roles, policies, overrides] = await Promise.all([
        prisma.userRole.findMany({
            where: { userId },
            select: { role: { select: { id: true, name: true, permissions: true } } }
        }),
        resolvePrincipalPolicyStatementsBySource(userId),
        prisma.userPermission.findMany({
            where: { userId },
            select: { id: true, permission: true, effect: true }
        })
    ]);
    const fromRoles: SourcedStatements[] = roles.map((row) => ({
        source: { kind: "role", id: row.role.id, name: row.role.name },
        statements: parseRoleGrants(row.role.permissions).map((key) => ({
            effect: "allow" as const,
            actions: [key],
            resources: ["*"]
        }))
    }));
    const fromPolicies: SourcedStatements[] = policies.map((entry) => ({
        source: {
            kind: "policy",
            id: entry.policyId,
            name: entry.policyName,
            principalType: entry.principalType,
            principalId: entry.principalId
        },
        statements: entry.statements
    }));
    const fromOverrides: SourcedStatements[] = overrides.map((row) => ({
        source: { kind: "account", id: row.id, name: row.permission },
        statements: [
            {
                effect: row.effect === "deny" ? ("deny" as const) : ("allow" as const),
                actions: [row.permission],
                resources: ["*"]
            }
        ]
    }));
    return [...fromRoles, ...fromPolicies, ...fromOverrides];
}

/** Whether a user holds a global capability. Admins are allowed everything. */
export async function can(userId: string, permission: Permission | typeof ALL_PERMISSIONS): Promise<boolean> {
    const admin = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (admin?.isAdmin) return true;
    const statements = await resolveGlobalStatements(userId);
    return isAllowed(statements, permission, GLOBAL_RESOURCE);
}

/**
 * The statements that decide reach: the policies attached to this user and the
 * grants written on individual things.
 *
 * Role grants are deliberately absent, and this is the load-bearing line of the
 * whole design. `roleStatements` compiles every role permission as
 * `resources: ["*"]`, so feeding them in here would make the seeded `member` role -
 * which carries `games.manage`, `deploy.manage` and `tasks.manage` - reach every
 * other account's server the moment a call site stopped filtering by owner. A role
 * answers "may this account use the feature at all"; ownership and these
 * statements answer "on which one".
 *
 * The same split Drive has always made (see drive-acl-service), now written once
 * for every kind of thing.
 */
export async function resolveResourceStatements(userId: string): Promise<PolicyStatement[]> {
    const [policies, grants] = await Promise.all([
        resolvePrincipalPolicyStatements(userId),
        resourceGrantStatements(userId)
    ]);
    return [...policies, ...grants];
}

/**
 * Whether a user may do something to one particular thing.
 *
 * Two gates, both of which have to pass, and a deny that overrides either:
 *
 *   1. An administrator passes everything, as everywhere else.
 *   2. Policies and resource grants are resolved at the thing itself. An explicit
 *      deny ends it; an allow is enough on its own, which is what lets somebody
 *      holding no global permission at all reach exactly one server.
 *   3. Failing that, the owner passes - but only while they still hold the global
 *      capability, so a viewer who owns a server stays a viewer on it.
 *
 * Note that (2) precedes (3), so a deny takes a thing away from its own owner.
 * That is deliberate, and it is how an operator suspends somebody's reach without
 * taking the thing off them. It differs from Drive, where the owner short-circuits
 * before policies are read; Drive is left as it is rather than changed underneath
 * rows that already exist.
 */
export async function canOn(
    userId: string,
    permission: Permission,
    ref: ResourceRef,
    opts?: { ownerId?: string | null }
): Promise<boolean> {
    const account = await prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } });
    if (account?.isAdmin) return true;

    const statements = await resolveResourceStatements(userId);
    const decision = evaluateStatements(statements, permission, resourceString(ref));
    if (decision === "deny") return false;
    if (decision === "allow") return true;

    return opts?.ownerId === userId && (await can(userId, permission));
}

/**
 * Held globally, or on at least one thing.
 *
 * What a landing page and the app switcher ask. Without it an account granted one
 * game server holds no global `games.read`, so the rail hides Game servers and the
 * page it was given access to turns it away - access it can reach only by being
 * sent the link every time. Never a substitute for `can`: the surfaces that create
 * things stay on the global question.
 */
export async function canAny(userId: string, permission: Permission): Promise<boolean> {
    if (await can(userId, permission)) return true;
    return holdsAnyGrantCarrying(userId, permission);
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
    const users = await prisma.user.findMany({ where: { ...VISIBLE_USER }, select: { id: true } });
    const decisions = await Promise.all(
        users.map(async (user) => ((await can(user.id, permission)) ? user.id : null))
    );
    return decisions.filter((id): id is string => id !== null);
}
