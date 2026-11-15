/**
 * Polar Code's session board: every session this account reaches, each in the
 * column its derived status puts it (`lib/agents/session-board.ts`).
 *
 * Two bounded reads, never the whole table. The sessions still running are
 * few by nature and are read in one go, up to `LIVE_CAP`; the finished ones
 * pile up forever, so the Done column is read a page at a time on its own
 * cursor. Each read is one query for the sessions, one for their pull request
 * rows and one for the names of whoever started them.
 *
 * Reach is the Agents app's own: the sessions on repositories this account
 * owns, and the workspaces it started itself.
 */

import * as core from "@polaris/core";
import { prisma, type Prisma } from "@polaris/db";
import * as board from "@/lib/agents/session-board";
import * as status from "@/lib/agents/session-status";
import { shownSessionBranch } from "@/lib/agents/session-branch";
import { readSessionCursor, sessionCursor } from "@/lib/agents/session-cursor";
import { pullFactsOf, readSessionPullRows, type PullCardRow } from "@/lib/agents/session-pr-facts";

/** The most running sessions one board read lists. */
export const LIVE_CAP = 150;
/** Finished sessions to a page of the Done column. */
export const DONE_PAGE = 30;

export interface BoardPull {
    readonly number: number;
    readonly url: string;
    readonly state: "open" | "merged" | "closed";
    readonly checks: board.ChecksSummary;
}

export interface BoardCard {
    readonly id: string;
    readonly title: string;
    /** `owner/name`, or empty for a workspace. */
    readonly repo: string;
    /** Empty until the session changed something worth naming a branch for. */
    readonly branch: string;
    readonly cli: string;
    /** The agent's product name, as the catalog spells it. */
    readonly agent: string;
    readonly personId: string | null;
    readonly personName: string;
    readonly column: board.BoardColumn;
    readonly status: status.SessionStatus;
    readonly pull: BoardPull | null;
    /** When it last reported, or started, or was created. */
    readonly at: string;
}

export interface BoardAnswer {
    readonly cards: readonly BoardCard[];
    /** Whether more sessions are running than `LIVE_CAP` lists. */
    readonly truncated: boolean;
    /** Where the next page of Done starts, or null on the last one. */
    readonly doneNext: string | null;
}

export interface DonePage {
    readonly cards: readonly BoardCard[];
    readonly doneNext: string | null;
}

const OVER: core.AgentSessionState[] = ["stopped", "failed"];

const CARD_SELECT = {
    id: true,
    title: true,
    cli: true,
    state: true,
    branch: true,
    startedById: true,
    lastEventAt: true,
    startedAt: true,
    createdAt: true,
    workState: true,
    workCommits: true,
    prUrl: true,
    repo: { select: { repoFullName: true } }
} as const;

type CardRecord = Prisma.AgentSessionGetPayload<{ select: typeof CARD_SELECT }>;

function reachOf(ownerId: string, filters: board.BoardFilters): Prisma.AgentSessionWhereInput {
    return {
        OR: [{ repo: { ownerId } }, { repoId: null, startedById: ownerId }],
        ...(filters.repo ? { repoId: filters.repo } : {}),
        ...(filters.agent ? { cli: filters.agent } : {}),
        ...(filters.person ? { startedById: filters.person } : {})
    };
}

function agentLabel(cli: string): string {
    return core.agentCliById(cli)?.label ?? cli;
}

/** One stored session and its pull request rows as a card. Pure: `now` is
 *  what the silence rule is measured against. */
export function cardOf(
    record: CardRecord,
    pulls: readonly PullCardRow[],
    names: ReadonlyMap<string, string>,
    now: Date
): BoardCard {
    const facts = pulls.map(pullFactsOf);
    const derived = status.deriveSessionStatus(
        status.sessionFactsFrom({
            state: record.state as core.AgentSessionState,
            lastEventAt: record.lastEventAt,
            startedAt: record.startedAt,
            createdAt: record.createdAt
        }),
        facts,
        now
    );
    const shown = board.cardPull(
        pulls.map((row) => ({ ...row, merged: row.state === "merged", closed: row.state === "closed" }))
    );
    const repo = record.repo?.repoFullName ?? "";
    return {
        id: record.id,
        title: record.title,
        repo,
        branch: shownSessionBranch({
            repoFullName: repo,
            branch: record.branch,
            work: record.workState ? { state: record.workState, commits: record.workCommits ?? 0 } : null,
            pullRequest: shown ?? record.prUrl ?? null
        }),
        cli: record.cli,
        agent: agentLabel(record.cli),
        personId: record.startedById,
        personName: record.startedById ? (names.get(record.startedById) ?? "") : "",
        column: board.boardColumnOf(derived, facts),
        status: derived,
        pull: shown
            ? {
                  number: shown.number,
                  url: shown.url,
                  state: shown.state === "merged" ? "merged" : shown.state === "closed" ? "closed" : "open",
                  checks: board.checksSummary(shown)
              }
            : null,
        at: (record.lastEventAt ?? record.startedAt ?? record.createdAt).toISOString()
    };
}

async function cardsOf(records: readonly CardRecord[], now: Date): Promise<BoardCard[]> {
    const people = [...new Set(records.map((record) => record.startedById).filter((id): id is string => !!id))];
    const [pulls, users] = await Promise.all([
        readSessionPullRows(records.map((record) => record.id)),
        people.length > 0
            ? prisma.user.findMany({ where: { id: { in: people } }, select: { id: true, name: true } })
            : Promise.resolve([])
    ]);
    const names = new Map(users.map((user) => [user.id, user.name]));
    return records.map((record) => cardOf(record, pulls.get(record.id) ?? [], names, now));
}

async function readDone(
    ownerId: string,
    filters: board.BoardFilters,
    after: { at: Date; id: string } | null,
    now: Date
): Promise<DonePage> {
    const records = await prisma.agentSession.findMany({
        where: {
            ...reachOf(ownerId, filters),
            state: { in: OVER },
            ...(after
                ? {
                      AND: [
                          {
                              OR: [
                                  { createdAt: { lt: after.at } },
                                  { createdAt: after.at, id: { lt: after.id } }
                              ]
                          }
                      ]
                  }
                : {})
        },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        // One more than a page, to know whether there is another.
        take: DONE_PAGE + 1,
        select: CARD_SELECT
    });
    const page = records.slice(0, DONE_PAGE);
    const last = page.at(-1);
    return {
        cards: await cardsOf(page, now),
        doneNext:
            records.length > DONE_PAGE && last
                ? sessionCursor({ id: last.id, createdAt: last.createdAt.toISOString() })
                : null
    };
}

/** The board's first read: every running session up to the cap, and the
 *  first page of Done. */
export async function readCodeBoard(
    ownerId: string,
    filters: board.BoardFilters,
    now: Date = new Date()
): Promise<BoardAnswer> {
    const [records, done] = await Promise.all([
        prisma.agentSession.findMany({
            where: { ...reachOf(ownerId, filters), state: { notIn: OVER } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            take: LIVE_CAP + 1,
            select: CARD_SELECT
        }),
        readDone(ownerId, filters, null, now)
    ]);
    const live = await cardsOf(records.slice(0, LIVE_CAP), now);
    return { cards: [...live, ...done.cards], truncated: records.length > LIVE_CAP, doneNext: done.doneNext };
}

/** The next page of Done, after the `doneNext` of the page before. */
export async function readDonePage(
    ownerId: string,
    filters: board.BoardFilters,
    cursor: string,
    now: Date = new Date()
): Promise<DonePage> {
    const after = readSessionCursor(cursor);
    if (!after) return { cards: [], doneNext: null };
    return readDone(ownerId, filters, after, now);
}

/** The ids of the running sessions the board shows, for its live stream. */
export async function liveBoardIds(ownerId: string, filters: board.BoardFilters): Promise<string[]> {
    const rows = await prisma.agentSession.findMany({
        where: { ...reachOf(ownerId, filters), state: { notIn: OVER } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: LIVE_CAP,
        select: { id: true }
    });
    return rows.map((row) => row.id);
}

export interface BoardOption {
    readonly id: string;
    readonly name: string;
}

/** A page of the repositories this account owns, for the repository filter. */
export async function boardRepoOptions(
    ownerId: string,
    query: string,
    cursor: string | null,
    ids?: readonly string[]
): Promise<{ items: BoardOption[]; next: string | null }> {
    const take = 30;
    const rows = await prisma.agentRepo.findMany({
        where: {
            ownerId,
            ...(ids ? { id: { in: [...ids] } } : {}),
            ...(query || cursor
                ? {
                      repoFullName: {
                          ...(query ? { contains: query, mode: "insensitive" as const } : {}),
                          ...(cursor ? { gt: cursor } : {})
                      }
                  }
                : {})
        },
        orderBy: { repoFullName: "asc" },
        take: take + 1,
        select: { id: true, repoFullName: true }
    });
    const page = rows.slice(0, take);
    return {
        items: page.map((row) => ({ id: row.id, name: row.repoFullName })),
        next: rows.length > take ? (page.at(-1)?.repoFullName ?? null) : null
    };
}

/** A page of the people who started a session this account reaches, for the
 *  person filter. Read from the sessions themselves, so it never names
 *  somebody the board could not show. */
export async function boardPeopleOptions(
    ownerId: string,
    query: string,
    cursor: string | null,
    ids?: readonly string[]
): Promise<{ items: BoardOption[]; next: string | null }> {
    const take = 30;
    // Somebody typed a name: the matching accounts first, bounded, then which
    // of them started anything in reach.
    const named = query
        ? (
              await prisma.user.findMany({
                  where: { name: { contains: query, mode: "insensitive" } },
                  take: 200,
                  select: { id: true }
              })
          ).map((row) => row.id)
        : null;
    const wanted = ids ? [...ids] : named;
    const groups = await prisma.agentSession.groupBy({
        by: ["startedById"],
        where: {
            ...reachOf(ownerId, {}),
            AND: [
                { startedById: { not: null } },
                ...(wanted ? [{ startedById: { in: wanted } }] : []),
                ...(cursor ? [{ startedById: { gt: cursor } }] : [])
            ]
        },
        orderBy: { startedById: "asc" },
        take: take + 1
    });
    const people = groups
        .slice(0, take)
        .map((group) => group.startedById)
        .filter((id): id is string => !!id);
    const users =
        people.length > 0
            ? await prisma.user.findMany({ where: { id: { in: people } }, select: { id: true, name: true } })
            : [];
    const names = new Map(users.map((user) => [user.id, user.name]));
    const page = people.map((id) => ({ id, name: names.get(id) ?? "" }));
    return { items: page, next: groups.length > take ? (people.at(-1) ?? null) : null };
}
