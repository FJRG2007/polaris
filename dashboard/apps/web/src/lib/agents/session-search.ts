/**
 * Search over the Code sessions somebody started: the title, the repository and
 * what they asked for in it.
 *
 * Bounded on the server: the scope is the person's own sessions, read through the
 * `startedById, createdAt` index, newest first, one page at a time. Only the
 * person's own prompts are searched, never the agent's output, which is both far
 * larger and not what anybody remembers a session by.
 */

import { z } from "zod";
import { prisma, type Prisma } from "@polaris/db";
import { searchTextSchema } from "@/lib/polar/shared";

/** Sessions per page of results. */
export const SESSION_SEARCH_PAGE = 20;

export const sessionSearchQuery = z
    .object({
        q: searchTextSchema,
        page: z.coerce.number().int().min(0).max(50).default(0)
    })
    .strict();

/** One session as a result lists it. */
export interface SessionSearchHit {
    readonly id: string;
    readonly title: string;
    readonly repoFullName: string | null;
    readonly state: string;
    readonly createdAt: string;
}

/** Which of the person's sessions match. Pure, so the scope is asserted in a test. */
export function sessionSearchWhere(userId: string, text: string): Prisma.AgentSessionWhereInput {
    const contains = { contains: text, mode: "insensitive" as const };
    return {
        startedById: userId,
        polarHiddenAt: null,
        OR: [
            { title: contains },
            { repo: { repoFullName: contains } },
            { messages: { some: { role: "user", kind: "text", body: contains } } }
        ]
    };
}

export async function searchSessions(
    userId: string,
    text: string,
    page: number
): Promise<{ results: SessionSearchHit[]; more: boolean }> {
    const rows = await prisma.agentSession.findMany({
        where: sessionSearchWhere(userId, text),
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        skip: page * SESSION_SEARCH_PAGE,
        // One more than a page, to know whether there is another.
        take: SESSION_SEARCH_PAGE + 1,
        select: { id: true, title: true, state: true, createdAt: true, repo: { select: { repoFullName: true } } }
    });
    return {
        results: rows.slice(0, SESSION_SEARCH_PAGE).map((row) => ({
            id: row.id,
            title: row.title,
            repoFullName: row.repo?.repoFullName ?? null,
            state: row.state,
            createdAt: row.createdAt.toISOString()
        })),
        more: rows.length > SESSION_SEARCH_PAGE
    };
}
