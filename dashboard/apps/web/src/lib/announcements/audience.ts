/**
 * Who an announcement reaches.
 *
 * One `where` over accounts, built from the pick (everyone, roles, groups,
 * organizations, people - any combination, as a union) and always leaving out
 * banned and disabled accounts. The live count on the compose screen and the
 * send read the same clause, so the number the administrator was shown is the
 * number it went to; the banner's "is this for you" is that clause answered in
 * memory (`matchesAudience`), from one read of the reader's memberships.
 */

import type { AudienceSpec } from "./schema";
import { prisma, VISIBLE_USER, type Prisma } from "@polaris/db";

export function audienceWhere(audience: AudienceSpec): Prisma.UserWhereInput {
    if (audience.everyone) return { ...VISIBLE_USER };
    const any: Prisma.UserWhereInput[] = [];
    if (audience.roleIds.length > 0)
        any.push({ roles: { some: { roleId: { in: audience.roleIds } } } });
    if (audience.groupIds.length > 0)
        any.push({ groups: { some: { groupId: { in: audience.groupIds } } } });
    if (audience.orgIds.length > 0) {
        any.push({ orgMemberships: { some: { orgId: { in: audience.orgIds } } } });
    }
    if (audience.userIds.length > 0) any.push({ id: { in: audience.userIds } });
    // Nothing picked matches nobody - never "no filter", which would be everyone.
    if (any.length === 0) return { id: { in: [] } };
    return { ...VISIBLE_USER, OR: any };
}

export async function countAudience(audience: AudienceSpec): Promise<number> {
    return prisma.user.count({ where: audienceWhere(audience) });
}

/** What one account belongs to, read once to match it against many audiences. */
export interface Membership {
    id: string;
    roleIds: ReadonlySet<string>;
    groupIds: ReadonlySet<string>;
    orgIds: ReadonlySet<string>;
}

/** One read for an account's roles, groups and organizations; null when it is banned or disabled. */
export async function membershipOf(userId: string): Promise<Membership | null> {
    const user = await prisma.user.findFirst({
        where: { id: userId, ...VISIBLE_USER },
        select: {
            roles: { select: { roleId: true } },
            groups: { select: { groupId: true } },
            orgMemberships: { select: { orgId: true } }
        }
    });
    if (!user) return null;
    return {
        id: userId,
        roleIds: new Set(user.roles.map((one) => one.roleId)),
        groupIds: new Set(user.groups.map((one) => one.groupId)),
        orgIds: new Set(user.orgMemberships.map((one) => one.orgId))
    };
}

/** `audienceWhere` answered in memory for an account already read with `membershipOf`. */
export function matchesAudience(member: Membership | null, audience: AudienceSpec): boolean {
    if (!member) return false;
    if (audience.everyone) return true;
    return (
        audience.roleIds.some((id) => member.roleIds.has(id)) ||
        audience.groupIds.some((id) => member.groupIds.has(id)) ||
        audience.orgIds.some((id) => member.orgIds.has(id)) ||
        audience.userIds.includes(member.id)
    );
}

const PAGE = 200;

/**
 * Every account in the audience, a page at a time by id, so a large instance is
 * never one read. `from` resumes after the last account a send reached.
 */
export async function* audiencePages(
    audience: AudienceSpec,
    from: string | null = null
): AsyncGenerator<string[]> {
    const where = audienceWhere(audience);
    let after: string | null = from;
    for (;;) {
        const rows: { id: string }[] = await prisma.user.findMany({
            where: after ? { AND: [where, { id: { gt: after } }] } : where,
            select: { id: true },
            orderBy: { id: "asc" },
            take: PAGE
        });
        if (rows.length === 0) return;
        yield rows.map((row) => row.id);
        if (rows.length < PAGE) return;
        after = rows[rows.length - 1]!.id;
    }
}
