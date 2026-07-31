/**
 * Access groups: named, reusable network rule sets a user attaches to their own
 * sign-ins and to individual API keys, instead of retyping the same allowlist per
 * target. A group belongs to the user who created it and is never visible to
 * anyone else, so every operation here is scoped by owner.
 *
 * Resolution is a union: the effective allowlist for a target is every attached
 * group's rules plus the target's own inline rules. An empty union means no
 * restriction, which is what makes "attach nothing" the safe default for an
 * account that has never configured this.
 */

import {
    parseStringList,
    stringifyList,
    unionRules,
    type AccessGroupInput,
    type EffectiveAccessRules,
    type StoredAccessRules
} from "@polaris/core";
import { prisma } from "@polaris/db";

/** One access group as the management UI shows it. */
export interface AccessGroupView {
    id: string;
    name: string;
    description: string | null;
    allowedCidrs: string[];
    allowedCountries: string[];
    allowedContinents: string[];
    /** How many API keys currently reference it, so deleting is an informed choice. */
    apiKeyCount: number;
    /** Whether it is attached to the owner's sign-ins. */
    appliedToSignIn: boolean;
}

/** Every group a user owns, with the usage counts the delete prompt needs. */
export async function listAccessGroups(ownerId: string): Promise<AccessGroupView[]> {
    const rows = await prisma.accessGroup.findMany({
        where: { ownerId },
        orderBy: { name: "asc" },
        include: { _count: { select: { apiKeys: true, users: true } } }
    });
    return rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        allowedCidrs: parseStringList(row.allowedCidrs),
        allowedCountries: parseStringList(row.allowedCountries),
        allowedContinents: parseStringList(row.allowedContinents),
        apiKeyCount: row._count.apiKeys,
        appliedToSignIn: row._count.users > 0
    }));
}

function toColumns(input: AccessGroupInput): StoredAccessRules & { name: string; description: string | null } {
    return {
        name: input.name,
        description: input.description?.trim() || null,
        allowedCidrs: stringifyList(input.allowedCidrs),
        allowedCountries: stringifyList(input.allowedCountries),
        allowedContinents: stringifyList(input.allowedContinents)
    };
}

/** Create a group. Names are unique per owner so the chips stay unambiguous. */
export async function createAccessGroup(
    ownerId: string,
    input: AccessGroupInput
): Promise<{ id?: string; error?: string }> {
    const taken = await prisma.accessGroup.findFirst({
        where: { ownerId, name: input.name },
        select: { id: true }
    });
    if (taken) return { error: "You already have a group with that name." };
    const created = await prisma.accessGroup.create({
        data: { ownerId, ...toColumns(input) },
        select: { id: true }
    });
    return { id: created.id };
}

/** Update a group the caller owns. A foreign id simply matches nothing. */
export async function updateAccessGroup(
    ownerId: string,
    id: string,
    input: AccessGroupInput
): Promise<{ error?: string }> {
    const taken = await prisma.accessGroup.findFirst({
        where: { ownerId, name: input.name, id: { not: id } },
        select: { id: true }
    });
    if (taken) return { error: "You already have a group with that name." };
    const result = await prisma.accessGroup.updateMany({ where: { id, ownerId }, data: toColumns(input) });
    if (result.count === 0) return { error: "That group no longer exists." };
    return {};
}

/** Delete a group the caller owns; its attachments cascade away with it. */
export async function deleteAccessGroup(ownerId: string, id: string): Promise<void> {
    await prisma.accessGroup.deleteMany({ where: { id, ownerId } });
}

/**
 * The allowlist a user's sign-ins must satisfy: their inline rules plus every
 * group attached to the account. An empty result means the account is reachable
 * from anywhere, which is the state of an account that never configured this.
 */
export async function resolveSignInRules(userId: string): Promise<EffectiveAccessRules> {
    const [inline, bindings] = await Promise.all([
        prisma.userSecurity.findUnique({
            where: { userId },
            select: { allowedCidrs: true, allowedCountries: true, allowedContinents: true }
        }),
        prisma.userAccessGroup.findMany({
            where: { userId, enforced: false },
            select: {
                group: { select: { allowedCidrs: true, allowedCountries: true, allowedContinents: true } }
            }
        })
    ]);
    return unionRules([inline, ...bindings.map((binding) => binding.group)]);
}

/**
 * The allowlist an administrator imposed on the account, resolved the same way
 * from the enforced columns and the enforced group bindings.
 *
 * This set is judged on its own, not folded into the one above: union semantics
 * would let the account widen an imposed limit simply by adding a rule of its
 * own, which is the opposite of what imposing one means. A request must satisfy
 * both sets, and an empty one restricts nothing.
 */
export async function resolveEnforcedRules(userId: string): Promise<EffectiveAccessRules> {
    const [inline, bindings] = await Promise.all([
        prisma.userSecurity.findUnique({
            where: { userId },
            select: { adminCidrs: true, adminCountries: true, adminContinents: true }
        }),
        prisma.userAccessGroup.findMany({
            where: { userId, enforced: true },
            select: {
                group: { select: { allowedCidrs: true, allowedCountries: true, allowedContinents: true } }
            }
        })
    ]);
    const own = inline
        ? {
              allowedCidrs: inline.adminCidrs,
              allowedCountries: inline.adminCountries,
              allowedContinents: inline.adminContinents
          }
        : null;
    return unionRules([own, ...bindings.map((binding) => binding.group)]);
}
