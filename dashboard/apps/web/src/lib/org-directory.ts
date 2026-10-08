/**
 * The organizations on this deployment, a page at a time.
 *
 * A hosting company that gives every customer an organization has as many of
 * them as it has customers, so the operator's list is read the way the people
 * directory is: oldest first, resuming after the last one shown, narrowed by the
 * database rather than by the page.
 */

import { z } from "zod";
import { prisma, type Prisma } from "@polaris/db";
import { like } from "@/lib/rich-text/mention-service";
import { after, decodeCursor, MAX_PAGE, pageOf, pageSize, type Page } from "@/lib/pagination/cursor";

export interface OrgDirectoryRow {
    readonly id: string;
    readonly slug: string;
    readonly name: string;
    readonly ownerName: string;
    readonly memberCount: number;
    readonly teamCount: number;
    readonly spaceCount: number;
}

/** How many organizations a page holds. */
export const ORG_PAGE = 50;

export const orgDirectoryQuerySchema = z.object({
    cursor: z.string().max(200).nullish(),
    query: z.string().trim().max(200).default(""),
    limit: z.number().int().min(1).max(MAX_PAGE).optional()
});

export type OrgDirectoryQuery = z.input<typeof orgDirectoryQuerySchema>;

/** By name, handle, or the owner's name or email. */
function orgWhere(query: string): Prisma.OrganizationWhereInput {
    if (!query) return {};
    const contains = like(query);
    return {
        OR: [
            { name: contains },
            { slug: contains },
            { owner: { is: { OR: [{ name: contains }, { email: contains }] } } }
        ]
    };
}

export async function listOrgDirectoryPage(input: OrgDirectoryQuery = {}): Promise<Page<OrgDirectoryRow>> {
    const parsed = orgDirectoryQuerySchema.parse(input);
    const size = pageSize(parsed.limit, ORG_PAGE);
    const keyset = decodeCursor(parsed.cursor);
    const filtered = orgWhere(parsed.query);
    const rows = await prisma.organization.findMany({
        where: keyset ? { AND: [filtered, after("createdAt", keyset)] } : filtered,
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: size + 1,
        select: {
            id: true,
            slug: true,
            name: true,
            createdAt: true,
            owner: { select: { name: true } },
            _count: { select: { members: true, teams: true, spaces: true } }
        }
    });
    const page = pageOf(rows, size, (row) => ({ at: row.createdAt, id: row.id }));
    return {
        items: page.items.map((org) => ({
            id: org.id,
            slug: org.slug,
            name: org.name,
            ownerName: org.owner.name,
            // The owner is not a member row, so the roster is one longer than the
            // table says.
            memberCount: org._count.members + 1,
            teamCount: org._count.teams,
            spaceCount: org._count.spaces
        })),
        next: page.next
    };
}
