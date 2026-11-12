/**
 * The issue search, as a person types it and as the database reads it.
 *
 * Sentry's syntax rather than one of our own, because whoever reads this screen
 * has typed it there: `is:unresolved assigned:me level:error env:production
 * release:1.4.2 firstSeen:-24h lastSeen:+7d project:web` plus free text. Pure
 * and client-safe: the bar parses it to draw its chips, and the server parses
 * the same string again before it builds a query, so the two can never read it
 * differently.
 */

import { z } from "zod";
import * as core from "@polaris/core";

export const ISSUE_STATUS_FILTERS = ["unresolved", "resolved", "ignored"] as const;
export type IssueStatusFilter = (typeof ISSUE_STATUS_FILTERS)[number];

/** How a list can be ordered. "events" is how many times it happened. */
export const ISSUE_SORTS = ["lastSeen", "firstSeen", "events", "users"] as const;
export type IssueSort = (typeof ISSUE_SORTS)[number];

/** Rows per page of every Telemetry list. */
export const PAGE_SIZE = 50;

/** What a new search starts on, as Sentry's does. */
export const DEFAULT_QUERY = "is:unresolved";

export const RANGE_UNITS = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 } as const;
export type RangeUnit = keyof typeof RANGE_UNITS;

/** `-24h` is "in the last 24 hours", `+7d` is "more than 7 days ago". */
export interface SeenRange {
    readonly within: boolean;
    readonly amount: number;
    readonly unit: RangeUnit;
}

/** "me", "none" (nobody), "any" (somebody), or a person's id. */
export type AssignedFilter = "me" | "none" | "any" | string;

export interface IssueQuery {
    readonly status: IssueStatusFilter | null;
    readonly assigned: AssignedFilter | null;
    readonly levels: readonly core.TelemetryLevel[];
    readonly environment: string | null;
    readonly release: string | null;
    readonly project: string | null;
    readonly firstSeen: SeenRange | null;
    readonly lastSeen: SeenRange | null;
    readonly text: string;
}

export const EMPTY_QUERY: IssueQuery = {
    status: null,
    assigned: null,
    levels: [],
    environment: null,
    release: null,
    project: null,
    firstSeen: null,
    lastSeen: null,
    text: ""
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANGE = /^([+-])(\d{1,4})([mhdw])$/;

/** Split on spaces, keeping `key:"two words"` and `"two words"` whole. */
export function tokenize(input: string): string[] {
    const tokens: string[] = [];
    const pattern = /(?:[^\s"]+:)?"[^"]*"?|\S+/g;
    for (const match of input.slice(0, 500).matchAll(pattern)) tokens.push(match[0]);
    return tokens;
}

function unquote(value: string): string {
    return value.replace(/^"/, "").replace(/"$/, "").trim();
}

export function parseRange(value: string): SeenRange | null {
    const match = RANGE.exec(value.trim());
    if (!match) return null;
    const amount = Number(match[2]);
    if (amount < 1) return null;
    return { within: match[1] === "-", amount, unit: match[3] as RangeUnit };
}

function rangeText(range: SeenRange): string {
    return `${range.within ? "-" : "+"}${range.amount}${range.unit}`;
}

/** The free text, with a quote around anything holding a space. */
function quoted(value: string): string {
    return /\s/.test(value) ? `"${value}"` : value;
}

export function parseIssueQuery(input: string): IssueQuery {
    const query: {
        -readonly [K in keyof IssueQuery]: IssueQuery[K] extends readonly (infer U)[] ? U[] : IssueQuery[K];
    } = { ...EMPTY_QUERY, levels: [] };
    const text: string[] = [];

    for (const token of tokenize(input)) {
        const colon = token.indexOf(":");
        const key = colon > 0 ? token.slice(0, colon).toLowerCase() : "";
        const value = colon > 0 ? unquote(token.slice(colon + 1)) : "";
        if (!key || !value) {
            const word = unquote(token);
            if (word) text.push(word);
            continue;
        }
        switch (key) {
            case "is": {
                const said = value.toLowerCase();
                if ((ISSUE_STATUS_FILTERS as readonly string[]).includes(said)) {
                    query.status = said as IssueStatusFilter;
                } else if (said === "all") query.status = null;
                else if (said === "assigned") query.assigned = "any";
                else if (said === "unassigned") query.assigned = "none";
                else text.push(token);
                break;
            }
            case "assigned": {
                const said = value.toLowerCase();
                if (said === "me" || said === "none" || said === "any") query.assigned = said;
                else if (UUID.test(value)) query.assigned = value.toLowerCase();
                else text.push(token);
                break;
            }
            case "level": {
                for (const part of value.toLowerCase().split(",")) {
                    if (
                        (core.TELEMETRY_LEVELS as readonly string[]).includes(part) &&
                        !query.levels.includes(part as core.TelemetryLevel)
                    ) {
                        query.levels.push(part as core.TelemetryLevel);
                    }
                }
                break;
            }
            case "env":
            case "environment":
                query.environment = value.slice(0, 200);
                break;
            case "release":
                query.release = value.slice(0, 200);
                break;
            case "project":
                query.project = value.slice(0, 200);
                break;
            case "firstseen":
            case "lastseen": {
                const range = parseRange(value);
                if (!range) {
                    text.push(token);
                    break;
                }
                if (key === "firstseen") query.firstSeen = range;
                else query.lastSeen = range;
                break;
            }
            default:
                text.push(token);
        }
    }
    query.text = text.join(" ").slice(0, 200);
    return query;
}

/** Back to the one canonical string, in a fixed order. */
export function serializeIssueQuery(query: IssueQuery): string {
    const parts: string[] = [];
    if (query.status) parts.push(`is:${query.status}`);
    if (query.assigned) parts.push(`assigned:${query.assigned}`);
    if (query.levels.length > 0) parts.push(`level:${query.levels.join(",")}`);
    if (query.environment) parts.push(`environment:${quoted(query.environment)}`);
    if (query.release) parts.push(`release:${quoted(query.release)}`);
    if (query.project) parts.push(`project:${quoted(query.project)}`);
    if (query.firstSeen) parts.push(`firstSeen:${rangeText(query.firstSeen)}`);
    if (query.lastSeen) parts.push(`lastSeen:${rangeText(query.lastSeen)}`);
    if (query.text) parts.push(query.text);
    return parts.join(" ");
}

/** The same search with one filter changed, as a chip or a dropdown does it. */
export function withFilter(input: string, change: Partial<IssueQuery>): string {
    return serializeIssueQuery({ ...parseIssueQuery(input), ...change });
}

/** The instant a range measures from. */
export function rangeEdge(range: SeenRange, now: Date): Date {
    return new Date(now.getTime() - range.amount * RANGE_UNITS[range.unit]);
}

/** The Prisma comparison a range stands for: on or after the edge, or before it. */
export function rangeWhere(range: SeenRange, now: Date): { gte: Date } | { lt: Date } {
    const edge = rangeEdge(range, now);
    return range.within ? { gte: edge } : { lt: edge };
}

/** The order a sort stands for, with the id last so a page boundary is stable. */
export function issueOrder(
    sort: IssueSort
): [Record<string, "desc">, { id: "desc" }] {
    const column = sort === "events" ? "timesSeen" : sort === "users" ? "userCount" : sort;
    return [{ [column]: "desc" }, { id: "desc" }];
}

/**
 * One page out of rows fetched one past the page size.
 *
 * The extra row is how "is there more" is answered without a count: it is
 * never shown, and the cursor is the last row that is.
 */
export function pageOf<T extends { id: string }>(
    rows: readonly T[],
    take: number
): { items: T[]; next: string | null } {
    const items = rows.slice(0, take);
    return { items, next: rows.length > take ? (items[items.length - 1]?.id ?? null) : null };
}

/** Prisma's cursor arguments for the page after `cursor`, fetching one extra. */
export function pageArgs(
    cursor: string | null | undefined,
    take: number
): { take: number; skip?: number; cursor?: { id: string } } {
    return cursor ? { take: take + 1, skip: 1, cursor: { id: cursor } } : { take: take + 1 };
}

const cursorSchema = z.string().uuid().nullish();

export const issueSearchSchema = z.object({
    query: z.string().max(500).default(""),
    sort: z.enum(ISSUE_SORTS).default("lastSeen"),
    cursor: cursorSchema,
    /** Set on a project's own list; the cross-project list names one with `project:`. */
    projectId: z.string().uuid().nullish()
});
export type IssueSearchInput = z.infer<typeof issueSearchSchema>;

export const eventPageSchema = z.object({
    projectId: z.string().uuid(),
    issueId: z.string().uuid().nullish(),
    cursor: cursorSchema
});

export const projectRefSchema = z.object({ projectId: z.string().uuid() });

export const eventRefSchema = z.object({
    projectId: z.string().uuid(),
    eventId: z.string().uuid()
});

export const activityPageSchema = z.object({
    projectId: z.string().uuid(),
    issueId: z.string().uuid(),
    cursor: cursorSchema
});

export const projectPageSchema = z.object({
    query: z.string().trim().max(80).default(""),
    cursor: cursorSchema
});

export const issueIdsSchema = z.array(z.string().uuid()).min(1).max(100);

export const RESOLVE_MODES = ["now", "nextRelease"] as const;
export type ResolveMode = (typeof RESOLVE_MODES)[number];

/** How long an ignore can be set to last, as Sentry offers it. */
export const IGNORE_WINDOWS = ["1h", "24h", "7d"] as const;
export type IgnoreWindow = (typeof IGNORE_WINDOWS)[number];
const IGNORE_WINDOW_MS: Readonly<Record<IgnoreWindow, number>> = {
    "1h": 3_600_000,
    "24h": 86_400_000,
    "7d": 604_800_000
};

/** How many more events an ignore can be set to wait for. */
export const IGNORE_COUNTS = [10, 100, 1000] as const;

/** When an ignore ends on its own. Neither set is "until somebody says". */
export interface IgnoreCondition {
    readonly ignoreFor?: IgnoreWindow;
    readonly ignoreCount?: number;
}

/** The two columns an ignore writes, from the issue's count as it is now. */
export function ignoreColumns(
    condition: IgnoreCondition | undefined,
    timesSeen: number,
    now: Date
): { ignoredUntil: Date | null; ignoreUntilSeen: number | null } {
    return {
        ignoredUntil: condition?.ignoreFor ? new Date(now.getTime() + IGNORE_WINDOW_MS[condition.ignoreFor]) : null,
        ignoreUntilSeen: condition?.ignoreCount ? timesSeen + condition.ignoreCount : null
    };
}

/**
 * Whether one more event opens an issue again, and why.
 *
 * Resolved and seen in a release other than the one it was resolved in is a
 * regression. Ignored with a condition, and the time has passed or this event
 * is the one it was waiting for, is an ignore that ran out. Pure, so the
 * ingest's decision can be asserted without a database.
 */
export function reopenReason(
    issue: {
        readonly status: string;
        readonly resolvedInRelease: string | null;
        readonly timesSeen: number;
        readonly ignoredUntil: Date | null;
        readonly ignoreUntilSeen: number | null;
    },
    release: string | null,
    now: Date
): "regressed" | "unignored" | null {
    if (issue.status === "resolved") {
        return issue.resolvedInRelease === null || issue.resolvedInRelease !== release ? "regressed" : null;
    }
    if (issue.status !== "ignored") return null;
    if (issue.ignoredUntil && now.getTime() >= issue.ignoredUntil.getTime()) return "unignored";
    if (issue.ignoreUntilSeen !== null && issue.timesSeen + 1 >= issue.ignoreUntilSeen) return "unignored";
    return null;
}

export const bulkStatusSchema = z.object({
    issueIds: issueIdsSchema,
    status: z.enum(core.TELEMETRY_STATUSES),
    /** Only read with "resolved". Left out, a resolve keeps the old meaning: the
     *  release it was last seen in does not reopen it. */
    mode: z.enum(RESOLVE_MODES).optional(),
    /** Only read with "ignored": when the ignore ends on its own. */
    ignoreFor: z.enum(IGNORE_WINDOWS).optional(),
    ignoreCount: z
        .number()
        .int()
        .refine((value) => (IGNORE_COUNTS as readonly number[]).includes(value))
        .optional()
});

export const assignSchema = z.object({
    issueIds: issueIdsSchema,
    assigneeId: z.string().uuid().nullable()
});

export const commentSchema = z.object({
    projectId: z.string().uuid(),
    issueId: z.string().uuid(),
    body: z.string().trim().min(1).max(5000)
});

export const issueTaskSchema = z.object({
    projectId: z.string().uuid(),
    issueId: z.string().uuid(),
    listId: z.string().uuid(),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().max(20_000).default(""),
    /** Put the issue's assignee (or, with nobody on it, the caller) on the task. */
    assign: z.boolean().default(true)
});

export const TELEMETRY_ACTIVITY_KINDS = ["comment", "status", "assign", "task"] as const;
export type TelemetryActivityKind = (typeof TELEMETRY_ACTIVITY_KINDS)[number];

/**
 * What a task made from an issue starts with: the error as its name and, as
 * its description, the facts somebody picking it up needs and a link back. The
 * lines arrive already in the reader's words; this only puts them in order.
 */
export function issueTaskDraft(
    issue: { readonly title: string; readonly culprit: string; readonly link: string },
    lines: { readonly where: string | null; readonly seen: string; readonly release: string | null }
): { name: string; description: string } {
    const name = issue.title.replace(/\s+/g, " ").trim().slice(0, 200) || issue.culprit.slice(0, 200);
    const body = [issue.title, lines.where, "", lines.seen, lines.release, "", issue.link];
    return {
        name: name || issue.link.slice(0, 200),
        description: body
            .filter((line): line is string => line !== null)
            .join("\n")
            .slice(0, 20_000)
    };
}
