/**
 * The servers a person may pick, a page at a time, filtered and ordered in the
 * database.
 *
 * Scoped exactly as using a server is: by owner, the check `getHostConnection`
 * makes before Polaris does anything on one. Ordered by name, then id to break
 * ties, so the cursor - the last row's pair - names where the next page starts
 * and a server added mid-scroll is neither shown twice nor skipped.
 */

import { z } from "zod";
import { prisma, type Prisma } from "@polaris/db";
import type { ServerFilter, ServerOption } from "@/lib/server-options-schema";

export interface ServerOptionsPage {
    readonly items: ServerOption[];
    readonly next: string | null;
}

const cursorSchema = z.tuple([z.string().max(300), z.string().uuid()]);

export function encodeServerCursor(name: string, id: string): string {
    return Buffer.from(JSON.stringify([name, id])).toString("base64url");
}

/** A cursor read back, or null for none and for anything that is not one. */
export function decodeServerCursor(raw: string | null): { name: string; id: string } | null {
    if (!raw) return null;
    try {
        const parsed = cursorSchema.safeParse(
            JSON.parse(Buffer.from(raw, "base64url").toString("utf8"))
        );
        return parsed.success ? { name: parsed.data[0], id: parsed.data[1] } : null;
    } catch {
        return null;
    }
}

/** The database filter for one person's servers under a picker's filters. */
export function serverOptionsWhere(
    ownerId: string,
    query: string,
    filter: ServerFilter,
    ids?: readonly string[],
    after?: { name: string; id: string } | null
): Prisma.HostWhereInput {
    const and: Prisma.HostWhereInput[] = [{ ownerId }];
    if (ids) and.push({ id: { in: [...ids] } });
    if (query) {
        and.push({
            OR: [
                { name: { contains: query, mode: "insensitive" } },
                { address: { contains: query, mode: "insensitive" } }
            ]
        });
    }
    if (filter.root) and.push({ OR: [{ sudo: true }, { username: "root" }] });
    if (filter.docker) and.push({ dockerId: { not: null } });
    if (filter.online) and.push({ offlineSince: null, status: "active" });
    if (filter.withoutVpnNode) and.push({ vpnNode: { is: null } });
    if (filter.exclude?.length) and.push({ id: { notIn: [...filter.exclude] } });
    if (after) {
        and.push({ OR: [{ name: { gt: after.name } }, { name: after.name, id: { gt: after.id } }] });
    }
    return { AND: and };
}

export async function readServerOptions(
    ownerId: string,
    request: {
        readonly query: string;
        readonly cursor: string | null;
        readonly limit: number;
        readonly ids?: readonly string[];
        readonly filter: ServerFilter;
    }
): Promise<ServerOptionsPage> {
    const after = decodeServerCursor(request.cursor);
    const rows = await prisma.host.findMany({
        where: serverOptionsWhere(ownerId, request.query, request.filter, request.ids, after),
        select: {
            id: true,
            name: true,
            address: true,
            os: true,
            environment: true,
            sudo: true,
            username: true,
            status: true,
            offlineSince: true
        },
        orderBy: [{ name: "asc" }, { id: "asc" }],
        // One past the page: the extra row is how the end is known without counting.
        take: request.limit + 1
    });
    const page = rows.slice(0, request.limit);
    const last = page[page.length - 1];
    return {
        items: page.map((row) => ({
            id: row.id,
            name: row.name,
            address: row.address,
            os: row.os,
            environment: row.environment,
            root: row.sudo || row.username === "root",
            online: row.offlineSince === null && row.status === "active"
        })),
        next: rows.length > request.limit && last ? encodeServerCursor(last.name, last.id) : null
    };
}
