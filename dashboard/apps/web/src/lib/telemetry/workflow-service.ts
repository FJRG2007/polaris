/**
 * What people do with an issue once it exists: find it, order it, resolve it,
 * hand it to somebody, talk about it, and turn it into a task.
 *
 * Every read here is a page: a cursor in, at most `PAGE_SIZE` rows out, and the
 * filtering and the ordering done by the database on the indexes the migration
 * `20270324000000_telemetry_workflow` adds. Access is the caller's job - these
 * take the project ids the caller already proved the reader may see.
 */

import * as core from "@polaris/core";
import * as q from "@/lib/telemetry/issue-query";
import * as taskAccess from "@/lib/tasks/access";
import { prisma, type Prisma } from "@polaris/db";
import * as report from "@/lib/telemetry/report-service";
import { notify } from "@/lib/notifications/dispatch";
import { translate } from "@/lib/i18n/translate";
import { getUserLocale } from "@/lib/i18n/locale-service";

export interface PersonLabel {
    readonly id: string;
    readonly name: string;
}

export interface IssueListRow extends report.IssueRow {
    readonly projectId: string;
    readonly projectName: string;
    readonly assignee: PersonLabel | null;
}

export interface EventRow {
    readonly id: string;
    readonly issueId: string;
    readonly level: string;
    readonly message: string;
    readonly culprit: string;
    readonly release: string | null;
    readonly environment: string | null;
    readonly userLabel: string | null;
    readonly at: string;
}

export interface ActivityRow {
    readonly id: string;
    readonly kind: string;
    readonly body: string;
    readonly ref: string | null;
    readonly at: string;
    readonly actor: PersonLabel | null;
}

export interface Page<T> {
    readonly items: T[];
    readonly next: string | null;
}

/** Names for a set of ids, in one read. */
export async function peopleNamed(ids: readonly (string | null)[]): Promise<Map<string, PersonLabel>> {
    const wanted = [...new Set(ids.filter((id): id is string => Boolean(id)))];
    if (wanted.length === 0) return new Map();
    const rows = await prisma.user.findMany({
        where: { id: { in: wanted } },
        select: { id: true, name: true }
    });
    return new Map(rows.map((row) => [row.id, row]));
}

/**
 * The database filter a parsed search stands for. Pure, so the search can be
 * asserted without a database.
 */
export function issueWhere(
    projectIds: readonly string[],
    query: q.IssueQuery,
    viewerId: string,
    now: Date
): Prisma.TelemetryIssueWhereInput {
    const and: Prisma.TelemetryIssueWhereInput[] = [{ projectId: { in: [...projectIds] } }];
    if (query.status) and.push({ status: query.status });
    if (query.assigned === "me") and.push({ assignedToId: viewerId });
    else if (query.assigned === "none") and.push({ assignedToId: null });
    else if (query.assigned === "any") and.push({ assignedToId: { not: null } });
    else if (query.assigned) and.push({ assignedToId: query.assigned });
    if (query.levels.length > 0) and.push({ level: { in: [...query.levels] } });
    if (query.environment) and.push({ events: { some: { environment: query.environment } } });
    if (query.release) {
        and.push({
            OR: [{ lastRelease: query.release }, { events: { some: { release: query.release } } }]
        });
    }
    if (query.firstSeen) and.push({ firstSeen: q.rangeWhere(query.firstSeen, now) });
    if (query.lastSeen) and.push({ lastSeen: q.rangeWhere(query.lastSeen, now) });
    if (query.text) {
        and.push({
            OR: [
                { title: { contains: query.text, mode: "insensitive" } },
                { culprit: { contains: query.text, mode: "insensitive" } }
            ]
        });
    }
    return { AND: and };
}

/** One page of issues across the given projects. */
export async function searchIssues(input: {
    projects: readonly { id: string; name: string }[];
    query: q.IssueQuery;
    sort: q.IssueSort;
    cursor?: string | null;
    viewerId: string;
    now?: Date;
}): Promise<Page<IssueListRow>> {
    const now = input.now ?? new Date();
    if (input.projects.length === 0) return { items: [], next: null };
    const names = new Map(input.projects.map((project) => [project.id, project.name]));
    const rows = await prisma.telemetryIssue.findMany({
        where: issueWhere([...names.keys()], input.query, input.viewerId, now),
        orderBy: q.issueOrder(input.sort),
        ...q.pageArgs(input.cursor, q.PAGE_SIZE),
        select: {
            id: true,
            projectId: true,
            title: true,
            type: true,
            culprit: true,
            level: true,
            status: true,
            timesSeen: true,
            userCount: true,
            firstSeen: true,
            lastSeen: true,
            lastRelease: true,
            assignedToId: true
        }
    });
    const page = q.pageOf(rows, q.PAGE_SIZE);
    const [daily, people] = await Promise.all([
        report.dailyCounts(
            page.items.map((row) => row.id),
            now
        ),
        peopleNamed(page.items.map((row) => row.assignedToId))
    ]);
    return {
        next: page.next,
        items: page.items.map(({ assignedToId, ...row }) => ({
            ...row,
            projectName: names.get(row.projectId) ?? "",
            firstSeen: row.firstSeen.toISOString(),
            lastSeen: row.lastSeen.toISOString(),
            daily: daily.get(row.id) ?? [],
            assignee: assignedToId ? (people.get(assignedToId) ?? null) : null
        }))
    };
}

/** One page of a project's events, or of one issue's, newest first. */
export async function listEventsPage(input: {
    projectId: string;
    issueId?: string | null;
    cursor?: string | null;
}): Promise<Page<EventRow>> {
    const rows = await prisma.telemetryEvent.findMany({
        where: input.issueId
            ? { issueId: input.issueId, projectId: input.projectId }
            : { projectId: input.projectId },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        ...q.pageArgs(input.cursor, q.PAGE_SIZE),
        select: {
            id: true,
            issueId: true,
            level: true,
            message: true,
            culprit: true,
            release: true,
            environment: true,
            userLabel: true,
            at: true
        }
    });
    const page = q.pageOf(rows, q.PAGE_SIZE);
    return {
        next: page.next,
        items: page.items.map((row) => ({ ...row, at: row.at.toISOString() }))
    };
}

/** One event whole, for the stream's detail view. */
export async function getEvent(projectId: string, eventId: string): Promise<(report.EventDetail & { issueId: string }) | null> {
    const row = await prisma.telemetryEvent.findFirst({
        where: { id: eventId, projectId },
        select: {
            id: true,
            issueId: true,
            eventId: true,
            level: true,
            message: true,
            culprit: true,
            release: true,
            environment: true,
            serverName: true,
            transaction: true,
            url: true,
            method: true,
            userLabel: true,
            detail: true,
            at: true
        }
    });
    if (!row) return null;
    const { issueId, ...event } = row;
    return { ...report.detailOf(event), issueId };
}

export interface ReleaseRow {
    readonly release: string;
    readonly events: number;
    readonly lastSeen: string;
}

/** The releases a project's kept events name, most recent first. */
export async function listReleases(projectId: string): Promise<ReleaseRow[]> {
    const rows = await prisma.telemetryEvent.groupBy({
        by: ["release"],
        where: { projectId, release: { not: null } },
        _count: { _all: true },
        _max: { at: true },
        orderBy: { _max: { at: "desc" } },
        take: 100
    });
    return rows
        .filter((row): row is typeof row & { release: string } => Boolean(row.release))
        .map((row) => ({
            release: row.release,
            events: row._count._all,
            lastSeen: (row._max.at ?? new Date(0)).toISOString()
        }));
}

export interface EnvironmentRow {
    readonly environment: string;
    readonly events: number;
    readonly lastSeen: string;
}

/** The environments a project's kept events name, most recent first. */
export async function listEnvironments(projectId: string): Promise<EnvironmentRow[]> {
    const rows = await prisma.telemetryEvent.groupBy({
        by: ["environment"],
        where: { projectId, environment: { not: null } },
        _count: { _all: true },
        _max: { at: true },
        orderBy: { _max: { at: "desc" } },
        take: 100
    });
    return rows
        .filter((row): row is typeof row & { environment: string } => Boolean(row.environment))
        .map((row) => ({
            environment: row.environment,
            events: row._count._all,
            lastSeen: (row._max.at ?? new Date(0)).toISOString()
        }));
}

/** Whether a project has any environment to list, without listing them. */
export async function hasEnvironments(projectId: string): Promise<boolean> {
    const row = await prisma.telemetryEvent.findFirst({
        where: { projectId, environment: { not: null } },
        select: { id: true }
    });
    return row !== null;
}

/** Whether a project has any release to list, without listing them. */
export async function hasReleases(projectId: string): Promise<boolean> {
    const row = await prisma.telemetryEvent.findFirst({
        where: { projectId, release: { not: null } },
        select: { id: true }
    });
    return row !== null;
}

/** The issues behind a set of ids, with the project each sits in. */
export async function issuesByIds(
    issueIds: readonly string[]
): Promise<{ id: string; projectId: string; lastRelease: string | null; title: string; timesSeen: number }[]> {
    return prisma.telemetryIssue.findMany({
        where: { id: { in: [...issueIds] } },
        select: { id: true, projectId: true, lastRelease: true, title: true, timesSeen: true },
        take: issueIds.length
    });
}

/**
 * The columns a status change writes for one issue.
 *
 * Resolving "now" means any later event reopens it; resolving in the next
 * release means an event from the release it was last seen in does not - it
 * is from before the fix shipped. Left unsaid, a resolve keeps what it always
 * meant here, which is the second.
 */
export function statusColumns(
    status: core.TelemetryStatus,
    lastRelease: string | null,
    by: string,
    mode: q.ResolveMode | undefined,
    now: Date,
    ignore?: q.IgnoreCondition,
    timesSeen = 0
): Prisma.TelemetryIssueUncheckedUpdateManyInput {
    const ignored =
        status === "ignored" ? q.ignoreColumns(ignore, timesSeen, now) : { ignoredUntil: null, ignoreUntilSeen: null };
    if (status !== "resolved") {
        return { status, resolvedAt: null, resolvedById: null, resolvedInRelease: null, ...ignored };
    }
    return {
        status,
        resolvedAt: now,
        resolvedById: by,
        resolvedInRelease: mode === "now" ? null : lastRelease,
        ...ignored
    };
}

/** Change the status of several issues, and write it in each one's log. */
export async function setStatusMany(
    issues: readonly { id: string; projectId: string; lastRelease: string | null; timesSeen?: number }[],
    status: core.TelemetryStatus,
    by: string,
    mode?: q.ResolveMode,
    ignore?: q.IgnoreCondition
): Promise<void> {
    const now = new Date();
    await prisma.$transaction([
        ...issues.map((issue) =>
            prisma.telemetryIssue.updateMany({
                where: { id: issue.id, projectId: issue.projectId },
                data: statusColumns(status, issue.lastRelease, by, mode, now, ignore, issue.timesSeen ?? 0)
            })
        ),
        prisma.telemetryActivity.createMany({
            data: issues.map((issue) => ({
                projectId: issue.projectId,
                issueId: issue.id,
                actorId: by,
                kind: "status",
                body: status === "resolved" && mode === "nextRelease" ? "resolvedNextRelease" : status
            }))
        })
    ]);
}

/** Hand several issues to somebody, or to nobody, and log it. */
export async function assignMany(
    issues: readonly { id: string; projectId: string }[],
    assigneeId: string | null,
    by: string
): Promise<void> {
    await prisma.$transaction([
        prisma.telemetryIssue.updateMany({
            where: { id: { in: issues.map((issue) => issue.id) } },
            data: { assignedToId: assigneeId }
        }),
        prisma.telemetryActivity.createMany({
            data: issues.map((issue) => ({
                projectId: issue.projectId,
                issueId: issue.id,
                actorId: by,
                kind: "assign",
                body: "",
                ref: assigneeId
            }))
        })
    ]);
}

/**
 * Tell the person issues were handed to. Nobody hears about handing work to
 * themselves; one issue links to that issue, several to the list of all.
 */
export async function notifyAssigned(
    issues: readonly { id: string; projectId: string; title: string }[],
    assigneeId: string,
    byId: string
): Promise<void> {
    const first = issues[0];
    if (!first || assigneeId === byId) return;
    const [locale, people] = await Promise.all([getUserLocale(assigneeId), peopleNamed([byId])]);
    const by = { name: people.get(byId)?.name ?? "" };
    const one = issues.length === 1;
    await notify({
        userId: assigneeId,
        event: "telemetry.assigned",
        title: one
            ? translate(locale, "telemetry.notify.assignedOne", { name: by.name })
            : translate(locale, "telemetry.notify.assignedMany", { name: by.name, count: issues.length }),
        body: one ? first.title.slice(0, 200) : null,
        href: one
            ? `/telemetry/${encodeURIComponent(first.projectId)}/issues/${encodeURIComponent(first.id)}`
            : "/telemetry/issues",
        dedupKey: null
    });
}

/** What the issue screen shows beside the event: who has it, and how it was resolved. */
export async function issueMeta(
    projectId: string,
    issueId: string
): Promise<{
    assignee: PersonLabel | null;
    resolvedInRelease: string | null;
    ignoredUntil: string | null;
    ignoreUntilSeen: number | null;
} | null> {
    const row = await prisma.telemetryIssue.findFirst({
        where: { id: issueId, projectId },
        select: { assignedToId: true, resolvedInRelease: true, ignoredUntil: true, ignoreUntilSeen: true }
    });
    if (!row) return null;
    const people = await peopleNamed([row.assignedToId]);
    return {
        assignee: row.assignedToId ? (people.get(row.assignedToId) ?? null) : null,
        resolvedInRelease: row.resolvedInRelease,
        ignoredUntil: row.ignoredUntil?.toISOString() ?? null,
        ignoreUntilSeen: row.ignoreUntilSeen
    };
}

export async function addActivity(input: {
    projectId: string;
    issueId: string;
    actorId: string;
    kind: q.TelemetryActivityKind;
    body: string;
    ref?: string | null;
}): Promise<void> {
    await prisma.telemetryActivity.create({ data: { ...input, ref: input.ref ?? null } });
}

/** One page of an issue's log, newest first. Assignments name who it went to. */
export async function listActivity(
    issueId: string,
    cursor?: string | null
): Promise<Page<ActivityRow>> {
    const rows = await prisma.telemetryActivity.findMany({
        where: { issueId },
        orderBy: [{ at: "desc" }, { id: "desc" }],
        ...q.pageArgs(cursor, q.PAGE_SIZE),
        select: { id: true, kind: true, body: true, ref: true, at: true, actorId: true }
    });
    const page = q.pageOf(rows, q.PAGE_SIZE);
    const people = await peopleNamed(
        page.items.flatMap((row) => [row.actorId, row.kind === "assign" ? row.ref : null])
    );
    return {
        next: page.next,
        items: page.items.map(({ actorId, ...row }) => ({
            ...row,
            body: row.kind === "assign" && row.ref ? (people.get(row.ref)?.name ?? "") : row.body,
            at: row.at.toISOString(),
            actor: actorId ? (people.get(actorId) ?? null) : null
        }))
    };
}

export interface TaskListOption {
    readonly id: string;
    readonly name: string;
    readonly spaceName: string;
}

/**
 * The lists a task made from an issue can go into, by name: the spaces this
 * account reaches, at most thirty answers. Whether it may add to the chosen one
 * is asked again when the task is made (`requireList`), as Tasks itself does.
 */
export async function findTaskLists(
    actor: taskAccess.TaskActor,
    query: string
): Promise<TaskListOption[]> {
    const scope = await taskAccess.visibleScope(actor);
    const spaceIds = taskAccess.scopeSpaceIds(scope);
    if (spaceIds.length === 0) return [];
    const term = query.trim().slice(0, 80);
    const rows = await prisma.taskList.findMany({
        where: {
            archived: false,
            spaceId: { in: spaceIds },
            ...(term
                ? {
                      OR: [
                          { name: { contains: term, mode: "insensitive" } },
                          { space: { name: { contains: term, mode: "insensitive" } } }
                      ]
                  }
                : {})
        },
        orderBy: [{ space: { name: "asc" } }, { name: "asc" }],
        take: 30,
        select: { id: true, name: true, space: { select: { name: true } } }
    });
    return rows.map((row) => ({ id: row.id, name: row.name, spaceName: row.space.name }));
}

/**
 * Whether somebody could open every one of these projects - the same rule
 * `requireProject` applies to the reader, asked about the person an issue is
 * being handed to, so nobody is assigned a fault they cannot see.
 */
export async function mayRead(
    userId: string,
    projectIds: readonly string[],
    held: ReadonlySet<string>
): Promise<boolean> {
    const [user, projects] = await Promise.all([
        prisma.user.findUnique({ where: { id: userId }, select: { isAdmin: true } }),
        prisma.telemetryProject.findMany({
            where: { id: { in: [...projectIds] } },
            select: { id: true, ownerId: true }
        })
    ]);
    if (!user) return false;
    if (user.isAdmin) return true;
    return projects.every((project) => project.ownerId === userId || held.has(project.id));
}
