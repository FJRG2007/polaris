/**
 * What one person can do, and where each answer comes from.
 *
 * The four screens this replaces could each say one part of it: a role's grants,
 * a group's membership, a policy document, a grant on one server. None of them
 * could answer the question somebody actually has, which is not "what does this
 * role hold" but "why can this person do that, and what do I change to stop it".
 *
 * The verdict is computed by the same pure engine a request goes through, over
 * the same statements, so the explanation and the decision cannot drift. What is
 * added is attribution: each source is run separately as well, and whatever it had
 * to say about a permission becomes a line the reader can act on.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as auth from "@polaris/auth";

/** One permission, decided and explained. */
export interface PermissionVerdict {
    readonly permission: core.Permission;
    readonly area: string;
    readonly label: string;
    readonly allowed: boolean;
    /** Everything that had something to say, in resolution order. */
    readonly reasons: { effect: "allow" | "deny"; label: string; href?: string }[];
}

/** Access to one particular thing, which no global row can express. */
export interface ResourceGrantView {
    readonly id: string;
    readonly kind: core.ResourceKind;
    readonly kindLabel: string;
    readonly resourceId: string;
    /** What the thing is called, when it still exists. */
    readonly resourceLabel: string;
    readonly principalType: string;
    readonly principalLabel: string;
    readonly actions: core.Permission[];
    readonly effect: "allow" | "deny";
    readonly canShare: boolean;
    readonly expiresAt: string | null;
    readonly expired: boolean;
    /** Where it is edited, when that is somewhere other than this page. */
    readonly href: string | null;
}

export interface AccessExplanation {
    readonly isAdmin: boolean;
    readonly global: PermissionVerdict[];
    readonly resources: ResourceGrantView[];
}

/** Names for the things grants point at, in one pass per kind. */
async function resourceLabels(
    grants: readonly auth.ResourceGrantRow[]
): Promise<Map<string, { label: string; href: string | null }>> {
    const ids = (kind: core.ResourceKind) =>
        grants.filter((grant) => grant.kind === kind).map((grant) => grant.resourceId);
    const [installs, projects, spaces, domains] = await Promise.all([
        prisma.installedApp.findMany({ where: { id: { in: ids("install") } }, select: { id: true, name: true } }),
        prisma.project.findMany({ where: { id: { in: ids("project") } }, select: { id: true, name: true } }),
        prisma.taskSpace.findMany({ where: { id: { in: ids("space") } }, select: { id: true, name: true } }),
        prisma.ownerDomain.findMany({ where: { id: { in: ids("domain") } }, select: { id: true, domain: true } })
    ]);
    const labels = new Map<string, { label: string; href: string | null }>();
    for (const row of installs) {
        labels.set(`install:${row.id}`, { label: row.name, href: `/apps/installed/${row.id}/access` });
    }
    for (const row of projects) {
        labels.set(`project:${row.id}`, { label: row.name, href: `/apps/deploy/${row.id}` });
    }
    for (const row of spaces) labels.set(`space:${row.id}`, { label: row.name, href: null });
    for (const row of domains) labels.set(`domain:${row.id}`, { label: row.domain, href: null });
    return labels;
}

/** Names for the principals a grant can be written for. */
async function principalLabels(
    grants: readonly auth.ResourceGrantRow[]
): Promise<Map<string, string>> {
    const ids = (type: string) =>
        grants.filter((grant) => grant.principalType === type).map((grant) => grant.principalId);
    const [groups, roles] = await Promise.all([
        prisma.group.findMany({ where: { id: { in: ids("group") } }, select: { id: true, name: true } }),
        prisma.role.findMany({ where: { id: { in: ids("role") } }, select: { id: true, name: true } })
    ]);
    const labels = new Map<string, string>();
    for (const row of groups) labels.set(`group:${row.id}`, `their ${row.name} group`);
    for (const row of roles) labels.set(`role:${row.id}`, `their ${row.name} role`);
    return labels;
}

/** How a statement source reads on the page, and where to go to change it. */
function describe(source: auth.StatementSource): { label: string; href: string } {
    if (source.kind === "role") return { label: `their ${source.name} role`, href: "/admin/roles" };
    // An override names the capability rather than a document, because that is
    // what somebody would go looking for: "chat, switched on for this account".
    if (source.kind === "account") {
        return { label: `${source.name}, set on this account`, href: "/admin/users" };
    }
    const via =
        source.principalType === "user"
            ? "attached to them"
            : source.principalType === "group"
              ? "through a group they are in"
              : "through a role they hold";
    return { label: `the ${source.name} policy, ${via}`, href: "/admin/policies" };
}

/** Everything this account may do, and why. */
export async function explainUserAccess(userId: string): Promise<AccessExplanation> {
    const [account, sourced, grants] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
        auth.resolveGlobalStatementsBySource(userId),
        auth.grantsForPrincipal("user", userId)
    ]);
    const isAdmin = account?.isAdmin === true;
    const flattened = sourced.flatMap((entry) => entry.statements);

    const global: PermissionVerdict[] = core.PERMISSIONS.map((permission) => {
        const meta = core.PERMISSION_META[permission];
        const reasons = sourced.flatMap((entry) => {
            const decision = core.evaluateStatements(entry.statements, permission, "*");
            if (decision === "implicit-deny") return [];
            const described = describe(entry.source);
            return [
                {
                    effect: decision === "deny" ? ("deny" as const) : ("allow" as const),
                    label: described.label,
                    href: described.href
                }
            ];
        });
        return {
            permission,
            area: meta.area,
            label: meta.label,
            // The same call a request makes, over the same statements.
            allowed: isAdmin || core.evaluateStatements(flattened, permission, "*") === "allow",
            reasons
        };
    });

    const [things, principals] = await Promise.all([resourceLabels(grants), principalLabels(grants)]);
    const now = Date.now();
    const resources: ResourceGrantView[] = grants.map((grant) => {
        const key = `${grant.kind}:${grant.resourceId}`;
        const thing = things.get(key);
        return {
            id: grant.id,
            kind: grant.kind,
            kindLabel: core.RESOURCE_KIND_META[grant.kind].label,
            resourceId: grant.resourceId,
            resourceLabel:
                grant.resourceId === core.EVERY_RESOURCE
                    ? `Every ${core.RESOURCE_KIND_META[grant.kind].label.toLowerCase()}`
                    : (thing?.label ?? "No longer exists"),
            principalType: grant.principalType,
            principalLabel: principals.get(`${grant.principalType}:${grant.principalId}`) ?? "them",
            actions: grant.actions,
            effect: grant.effect,
            canShare: grant.canShare,
            expiresAt: grant.expiresAt?.toISOString() ?? null,
            expired: grant.expiresAt !== null && grant.expiresAt.getTime() <= now,
            href: thing?.href ?? null
        };
    });

    return { isAdmin, global, resources };
}
