/**
 * Who an announcement reaches.
 *
 * One `where` over accounts, built from the pick (everyone, roles, groups,
 * organizations, people - any combination, as a union) and always leaving out
 * banned and disabled accounts. The live count on the compose screen, the send
 * and the banner's "is this for you" all read the same clause, so the number
 * the administrator was shown is the number it went to.
 */

import type { AudienceSpec } from "./schema";
import { prisma, VISIBLE_USER, type Prisma } from "@polaris/db";

export function audienceWhere(audience: AudienceSpec): Prisma.UserWhereInput {
    if (audience.everyone) return { ...VISIBLE_USER };
    const any: Prisma.UserWhereInput[] = [];
    if (audience.roleIds.length > 0) any.push({ roles: { some: { roleId: { in: audience.roleIds } } } });
    if (audience.groupIds.length > 0) any.push({ groups: { some: { groupId: { in: audience.groupIds } } } });
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

/** Whether one account is in the audience. */
export async function inAudience(userId: string, audience: AudienceSpec): Promise<boolean> {
    const found = await prisma.user.count({ where: { AND: [{ id: userId }, audienceWhere(audience)] } });
    return found > 0;
}

const PAGE = 200;

/** Every account in the audience, a page at a time by id, so a large instance is never one read. */
export async function* audiencePages(audience: AudienceSpec): AsyncGenerator<string[]> {
    const where = audienceWhere(audience);
    let after: string | null = null;
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
