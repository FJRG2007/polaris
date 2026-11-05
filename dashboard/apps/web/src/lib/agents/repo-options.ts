/**
 * A person's connected repositories, a page at a time, for the pickers that
 * start a session on one.
 *
 * Searched and ordered by full name in the database and continued on it: the
 * name is unique per owner (`@@unique([ownerId, repoFullName])`), so it is a
 * whole keyset on its own and the page is one range scan of that index.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";

export interface RepoOption {
    id: string;
    name: string;
}

/** The first page a dialog reads before anybody searches. */
export const FIRST_REPO_PAGE = 50;

export const repoOptionsInput = z
    .object({
        query: z.string().trim().max(200).default(""),
        cursor: z.string().max(1024).nullable().default(null),
        limit: z.number().int().min(1).max(FIRST_REPO_PAGE).default(FIRST_REPO_PAGE),
        /** Read these back by id - how a picker names, or misses, a chosen repository. */
        ids: z.array(z.string().uuid()).min(1).max(50).optional()
    })
    .strict();

export type RepoOptionsRequest = z.output<typeof repoOptionsInput>;

function encodeCursor(name: string): string {
    return Buffer.from(JSON.stringify([name])).toString("base64url");
}

/** A cursor read back, or null for none and for anything that is not one. */
function decodeCursor(raw: string | null): string | null {
    if (!raw) return null;
    try {
        const [name] = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown[];
        return typeof name === "string" ? name : null;
    } catch {
        return null;
    }
}

/** One page of the owner's enabled repositories, or the ones named by id. */
export async function repoOptionsPage(
    ownerId: string,
    request: RepoOptionsRequest
): Promise<{ items: RepoOption[]; next: string | null }> {
    const after = decodeCursor(request.cursor);
    const rows = await prisma.agentRepo.findMany({
        where: {
            ownerId,
            enabled: true,
            ...(request.ids ? { id: { in: [...request.ids] } } : {}),
            ...(request.query || after
                ? {
                      repoFullName: {
                          ...(request.query
                              ? { contains: request.query, mode: "insensitive" as const }
                              : {}),
                          ...(after ? { gt: after } : {})
                      }
                  }
                : {})
        },
        select: { id: true, repoFullName: true },
        orderBy: { repoFullName: "asc" },
        // One past the page: the extra row is how the end is known without counting.
        take: request.limit + 1
    });
    const page = rows.slice(0, request.limit);
    const last = page[page.length - 1];
    return {
        items: page.map((row) => ({ id: row.id, name: row.repoFullName })),
        next: rows.length > request.limit && last ? encodeCursor(last.repoFullName) : null
    };
}

/** The first page, as a dialog opens. */
export function firstRepoPage(ownerId: string) {
    return repoOptionsPage(ownerId, repoOptionsInput.parse({}));
}
