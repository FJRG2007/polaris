/**
 * The firewall's require-login rule, written on its own.
 *
 * The firewall pages write a scope's whole rule at once; a service's Settings tab
 * and the new-service form only ever touch the login part of it. Both go through
 * here and then through `setWafRule`, so the rule a service's settings switch on is
 * the very row the firewall shows - there is no second copy to drift.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import { blockedBetween } from "@/lib/blocks";
import { discoverableBy } from "@/lib/privacy-service";
import { getWafRule, setWafRule } from "@/lib/waf-service";
import type { WafPrincipalGrant, WafPrincipalType, WafScopeType } from "@polaris/core";

/** The ids of one kind among `type:id` refs, keeping only well-formed ones. */
export function principalIdsOf(refs: readonly string[], type: WafPrincipalType): string[] {
    const ids = refs
        .filter((ref) => ref.startsWith(`${type}:`))
        .map((ref) => ref.slice(type.length + 1));
    return ids.filter((id) => z.string().uuid().safeParse(id).success);
}

/**
 * Whether every entry in `sent` that `kept` does not already hold is one the
 * caller could have picked: their own roles and groups, and people they could
 * find anywhere else in Polaris. An administrator may name anybody.
 */
export async function principalsWithinReach(
    user: { id: string; isAdmin: boolean },
    sent: readonly string[],
    kept: ReadonlySet<string>
): Promise<boolean> {
    if (user.isAdmin) return true;
    const added = [...new Set(sent.filter((ref) => !kept.has(ref)))];
    if (added.length === 0) return true;
    const roleIds = principalIdsOf(added, "role");
    const groupIds = principalIdsOf(added, "group");
    const allUserIds = principalIdsOf(added, "user");
    const userIds = allUserIds.filter((id) => id !== user.id);
    // An entry that is not a well-formed id of a known kind is nothing the picker offered.
    if (roleIds.length + groupIds.length + allUserIds.length !== added.length) return false;
    const [roles, groups, findable, blocked] = await Promise.all([
        roleIds.length
            ? prisma.userRole.findMany({
                  where: { userId: user.id, roleId: { in: roleIds } },
                  select: { roleId: true }
              })
            : [],
        groupIds.length
            ? prisma.groupMember.findMany({
                  where: { userId: user.id, groupId: { in: groupIds } },
                  select: { groupId: true }
              })
            : [],
        userIds.length
            ? discoverableBy({ id: user.id, isAdmin: false }, userIds)
            : new Set<string>(),
        userIds.length ? blockedBetween(user.id, userIds) : new Set<string>()
    ]);
    const heldRoles = new Set(roles.map((row) => row.roleId));
    const heldGroups = new Set(groups.map((row) => row.groupId));
    return (
        roleIds.every((id) => heldRoles.has(id)) &&
        groupIds.every((id) => heldGroups.has(id)) &&
        userIds.every((id) => findable.has(id) && !blocked.has(id))
    );
}

/** The login part of a scope's rule. A field left out keeps what is stored. */
export interface WafLoginPatch {
    requireLogin?: boolean;
    loginAllowPrincipals?: WafPrincipalGrant[];
    loginDenyPrincipals?: WafPrincipalGrant[];
}

/**
 * Write the login part of one scope's rule, leaving every other control as stored.
 * Ownership is checked by `getWafRule`/`setWafRule`; an entry outside the caller's
 * reach refuses the whole write and nothing is stored.
 */
export async function setWafLogin(
    user: { id: string; isAdmin: boolean },
    scopeType: WafScopeType,
    scopeId: string,
    patch: WafLoginPatch
): Promise<"outOfReach" | null> {
    const stored = await getWafRule(user.id, scopeType, scopeId);
    const kept = new Set(
        [...stored.loginAllowPrincipals, ...stored.loginDenyPrincipals].map((grant) => grant.ref)
    );
    const sent = [...(patch.loginAllowPrincipals ?? []), ...(patch.loginDenyPrincipals ?? [])].map(
        (grant) => grant.ref
    );
    if (!(await principalsWithinReach(user, sent, kept))) return "outOfReach";
    await setWafRule(user.id, scopeType, scopeId, {
        ...stored,
        requireLogin: patch.requireLogin ?? stored.requireLogin,
        loginAllowPrincipals: patch.loginAllowPrincipals ?? stored.loginAllowPrincipals,
        loginDenyPrincipals: patch.loginDenyPrincipals ?? stored.loginDenyPrincipals
    });
    return null;
}
