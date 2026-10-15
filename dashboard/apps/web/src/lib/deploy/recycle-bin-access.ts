/**
 * Whose recycle bin the open shelf shows, and whether this person may change how
 * it behaves. A person decides for their own projects; for an organization's, it
 * takes the organization's `settings.manage` (its owners and admins hold it).
 */

import { resolveScope } from "@/lib/workspace-scope";
import { userHasManage, type SessionUser } from "@/lib/session";
import { orgCan, resolveOrgAccess } from "@/lib/orgs/org-service";
import { binPolicyFor, type BinPolicy, type BinScope } from "@/lib/deploy/recycle-bin";

/** Why the policy is shown but cannot be changed, or null when it can. */
export type BinPolicyLock = "noDeploy" | "notOrgAdmin" | null;

export interface BinPolicyView {
    readonly scope: BinScope;
    /** The organization's name on an organization's shelf, else null. */
    readonly orgName: string | null;
    readonly policy: BinPolicy;
    readonly lock: BinPolicyLock;
}

/** Why `user` may not change this scope's policy, or null when they may. */
export async function binPolicyLock(user: SessionUser, scope: BinScope): Promise<BinPolicyLock> {
    if (!(await userHasManage(user, "deploy.manage"))) return "noDeploy";
    if (!scope.orgId) return null;
    const access = await resolveOrgAccess({ id: user.id, isAdmin: user.isAdmin }, scope.orgId);
    return orgCan(access, "settings.manage") ? null : "notOrgAdmin";
}

/** The open shelf's bin: whose it is, what it does, and whether `user` may change it. */
export async function openShelfBinPolicy(user: SessionUser): Promise<BinPolicyView> {
    const { org } = await resolveScope(user.id);
    const scope: BinScope = { orgId: org?.id ?? null, userId: user.id };
    const [policy, lock] = await Promise.all([binPolicyFor(scope), binPolicyLock(user, scope)]);
    return { scope, orgName: org?.name ?? null, policy, lock };
}
