"use server";

/**
 * Reading and working through what broke.
 *
 * The screen renders its shell immediately and asks for the numbers, which is
 * why the read is an action rather than page data: the window and the filter
 * change constantly, and holding the whole page back for a database read every
 * time somebody clicks a tab is a blank page every time somebody clicks a tab.
 *
 * Access is the same pair Analytics and the firewall use - `deploy.manage` to
 * open the app at all, and ownership of the project for everything inside it -
 * plus every instance administrator, which is how Polaris' own project is
 * reachable by whoever runs the box rather than only by whoever installed it.
 * A project shared with somebody (`telemetry.project`) lets them in without
 * `deploy.manage`: as `view` to read its issues, as `edit` to also work them
 * and its reporter rules and settings. Its key, deleting it and sharing it
 * stay with its owner, and making a project still needs `deploy.manage`.
 */

import * as core from "@polaris/core";
import { revalidatePath } from "next/cache";
import { slugify } from "@polaris/deploy";
import { appBaseUrl } from "@/lib/domain-service";
import { requirePermission, requireUser, sessionCan } from "@/lib/session";
import { findPeople } from "@/lib/people-search";
import * as q from "@/lib/telemetry/issue-query";
import * as workflow from "@/lib/telemetry/workflow-service";
import * as taskAccess from "@/lib/tasks/access";
import * as tasks from "@/lib/tasks/task-service";
import { dropGrantsFor, grantedSubjects } from "@/lib/access/grants";
import { requireTelemetryReader } from "@/lib/telemetry/reader";
import { scopeOrgIdFor } from "@/lib/workspace-scope";
import * as report from "@/lib/telemetry/report-service";
import * as projects from "@/lib/telemetry/project-service";
import { getTranslations } from "@/lib/i18n/request";
import type { NamespaceKey } from "@/lib/i18n/types";

type TelemetryKey = NamespaceKey<"telemetry">;

/** A reply in the reader's language. */
async function say(key: TelemetryKey): Promise<string> {
    return (await getTranslations("telemetry"))(key);
}

/** The access refusals the project service throws, by their English. */
const ACCESS_WORDS: Readonly<Record<string, TelemetryKey>> = {
    "That project no longer exists": "errors.projectGone",
    "You do not have access to that project": "errors.noAccess"
};

/** The shared schema's own sentences. */
const SCHEMA_WORDS: Readonly<Record<string, TelemetryKey>> = {
    "Name at least one address, or nothing will be able to report": "errors.nameAddress"
};

const PATH = "/telemetry";

/** The caller, and the projects shared with them as `edit` - the only shared
 *  ones anything that changes a project lets through. */
async function editor(): Promise<{
    caller: projects.TelemetryActor;
    editable: ReadonlySet<string>;
    manages: boolean;
}> {
    const { actor: caller, editable, manages } = await requireTelemetryReader();
    return { caller, editable, manages };
}

/** The project, when this caller may change it: as its owner or an
 *  administrator who still runs services, or through an `edit` share. An
 *  owner who lost `deploy.manage` is refused changes, as before shares. */
async function requireEditable(
    caller: projects.TelemetryActor,
    projectId: string,
    editable: ReadonlySet<string>,
    manages: boolean
): ReturnType<typeof projects.requireProject> {
    if (!manages && !editable.has(projectId)) throw new projects.TelemetryAccessError();
    return projects.requireProject(caller, projectId, editable);
}

async function actor(): Promise<projects.TelemetryActor> {
    const user = await requirePermission("deploy.manage");
    return { id: user.id, isAdmin: user.isAdmin };
}

async function failure(caught: unknown, fallback: TelemetryKey): Promise<{ error: string }> {
    if (caught instanceof projects.TelemetryAccessError) {
        const key = ACCESS_WORDS[caught.message];
        return { error: key ? await say(key) : caught.message };
    }
    console.error("polaris: a telemetry action failed:", caught);
    return { error: await say(fallback) };
}

export interface TelemetryOverview {
    /** The project the screen is open on, when it is one this reader may see.
     *  Every list of projects and issues is read in pages through its own route. */
    readonly projects: readonly (projects.ProjectSummary & { dsn: string })[];
    readonly counts: Readonly<Record<string, number>>;
    readonly windowDays: number;
    readonly hasReleases: boolean;
}

export async function telemetryOverviewAction(input: {
    projectId?: string | null;
}): Promise<{ data?: TelemetryOverview; error?: string }> {
    const { actor: caller, lent, editable } = await requireTelemetryReader();
    try {
        const wanted = q.projectRefSchema.safeParse({ projectId: input.projectId });
        if (!wanted.success) {
            return {
                data: {
                    projects: [],
                    counts: {},
                    windowDays: report.TELEMETRY_WINDOW_DAYS,
                    hasReleases: false
                }
            };
        }
        const [rows, origin] = await Promise.all([
            readableProjects(caller, lent, editable, wanted.data.projectId),
            appBaseUrl()
        ]);
        const chosen = rows[0];
        if (!chosen) {
            await projects.requireProject(caller, wanted.data.projectId, lent);
            return await failure(new projects.TelemetryAccessError(), "errors.readProjects");
        }
        const [counts, releases] = await Promise.all([
            report.issueCounts(chosen.id),
            workflow.hasReleases(chosen.id)
        ]);
        return {
            data: {
                projects: [{ ...chosen, dsn: projects.dsnFor(chosen, origin) }],
                counts,
                windowDays: report.TELEMETRY_WINDOW_DAYS,
                hasReleases: releases
            }
        };
    } catch (caught) {
        return await failure(caught, "errors.readProjects");
    }
}

export type OpenIssue = report.IssueDetail & {
    readonly assignee: workflow.PersonLabel | null;
    readonly resolvedInRelease: string | null;
};

export async function openIssueAction(
    projectId: string,
    issueId: string
): Promise<{ issue?: OpenIssue; error?: string }> {
    const { actor: caller, lent } = await requireTelemetryReader();
    try {
        await projects.requireProject(caller, projectId, lent);
        const [issue, meta] = await Promise.all([
            report.getIssue(projectId, issueId),
            workflow.issueMeta(projectId, issueId)
        ]);
        if (!issue || !meta) return { error: await say("errors.issueGone") };
        return { issue: { ...issue, ...meta } };
    } catch (caught) {
        return await failure(caught, "errors.readIssue");
    }
}

export async function setIssueStatusAction(
    projectId: string,
    issueId: string,
    status: string
): Promise<{ error?: string }> {
    const { caller, editable, manages } = await editor();
    if (!(core.TELEMETRY_STATUSES as readonly string[]).includes(status)) {
        return { error: await say("errors.badStatus") };
    }
    try {
        await requireEditable(caller, projectId, editable, manages);
        const found = (await workflow.issuesByIds([String(issueId)])).filter(
            (issue) => issue.projectId === projectId
        );
        await workflow.setStatusMany(found, status as core.TelemetryStatus, caller.id);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return await failure(caught, "errors.changeIssue");
    }
}

export async function deleteIssueAction(
    projectId: string,
    issueId: string
): Promise<{ error?: string }> {
    const { caller, editable, manages } = await editor();
    try {
        await requireEditable(caller, projectId, editable, manages);
        await report.deleteIssue(projectId, issueId);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return await failure(caught, "errors.deleteIssue");
    }
}

export async function createTelemetryProjectAction(
    name: unknown
): Promise<{ id?: string; error?: string }> {
    const caller = await actor();
    const said = String(name ?? "").trim();
    if (!said || said.length > 80) return { error: await say("errors.name") };
    try {
        const orgId = await scopeOrgIdFor(caller.id);
        const made = await projects.createProject({
            ownerId: caller.id,
            orgId,
            name: said,
            slug: slugify(said) || "project"
        });
        revalidatePath(PATH);
        return { id: made.id };
    } catch (caught) {
        return await failure(caught, "errors.makeProject");
    }
}

export async function updateTelemetryProjectAction(
    projectId: string,
    input: { name?: string; enabled?: boolean; retentionDays?: number }
): Promise<{ error?: string }> {
    const { caller, editable, manages } = await editor();
    try {
        await requireEditable(caller, projectId, editable, manages);
        const days = input.retentionDays;
        if (days !== undefined && (!Number.isInteger(days) || days < 1 || days > 365)) {
            return { error: await say("errors.retention") };
        }
        await projects.updateProject(projectId, input);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return await failure(caught, "errors.changeProject");
    }
}

/** A new key, and a new DSN with it. The old one stops working immediately,
 *  which is the point of asking for it. */
export async function rotateTelemetryKeyAction(
    projectId: string
): Promise<{ dsn?: string; error?: string }> {
    const caller = await actor();
    try {
        const project = await projects.requireProject(caller, projectId);
        const publicKey = await projects.rotateKey(projectId);
        revalidatePath(PATH);
        return { dsn: projects.dsnFor({ number: project.number, publicKey }, await appBaseUrl()) };
    } catch (caught) {
        return await failure(caught, "errors.rotateKey");
    }
}

export async function deleteTelemetryProjectAction(projectId: string): Promise<{ error?: string }> {
    const caller = await actor();
    try {
        await projects.requireProject(caller, projectId);
        if (!(await projects.deleteProject(projectId))) {
            return { error: await say("errors.ownProject") };
        }
        await dropGrantsFor("telemetry.project", projectId);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return await failure(caught, "errors.deleteProject");
    }
}

/**
 * Who may report into a project.
 *
 * The one screen in this app that changes what the ingest will accept, so the
 * input is checked against a schema rather than trusted: a rule that is not an
 * address, or "only these addresses" with none named, would be a project that
 * silently turns away everything.
 */
export async function setReporterRulesAction(
    projectId: string,
    input: unknown
): Promise<{ error?: string }> {
    const { caller, editable, manages } = await editor();
    const parsed = core.reporterRulesSchema.safeParse(input);
    if (!parsed.success) {
        const message = parsed.error.issues[0]?.message;
        const key = message ? SCHEMA_WORDS[message] : undefined;
        return { error: await say(key ?? "errors.readRules") };
    }
    try {
        await requireEditable(caller, projectId, editable, manages);
        await projects.setReporterRules(projectId, parsed.data);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return await failure(caught, "errors.saveRules");
    }
}

/**
 * A key of the project's own, shown once.
 *
 * The address in a DSN is public by design; this is not, and there is nowhere to
 * read it back from - what is stored is a digest. Somebody who loses it mints
 * another, which is the same thing as rotating it.
 */
export async function mintTelemetrySecretAction(
    projectId: string
): Promise<{ secret?: string; error?: string }> {
    const { caller, editable, manages } = await editor();
    try {
        await requireEditable(caller, projectId, editable, manages);
        const secret = await projects.mintSecret(projectId);
        revalidatePath(PATH);
        return { secret };
    } catch (caught) {
        return await failure(caught, "errors.makeKey");
    }
}

/** Stop asking for a key, and forget the one there was. */
export async function clearTelemetrySecretAction(projectId: string): Promise<{ error?: string }> {
    const { caller, editable, manages } = await editor();
    try {
        await requireEditable(caller, projectId, editable, manages);
        await projects.clearSecret(projectId);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return await failure(caught, "errors.removeKey");
    }
}

/** Forget what was turned away, once somebody has read it and acted on it. */
export async function clearTelemetryRefusalsAction(projectId: string): Promise<{ error?: string }> {
    const { caller, editable, manages } = await editor();
    try {
        await requireEditable(caller, projectId, editable, manages);
        await projects.clearRefusals(projectId);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return await failure(caught, "errors.clear");
    }
}
// ---------------------------------------------------------------------------
// The issue workflow: search, pages, bulk changes, assignment, tasks, comments.
// Reads are answered through routes (see telemetry-polls.ts); every input is
// parsed with the schemas in lib/telemetry/issue-query before it is used.
// ---------------------------------------------------------------------------

/** The projects a reader may see, or the one a screen is open on. */
async function readableProjects(
    caller: projects.TelemetryActor,
    lent: ReadonlySet<string>,
    editable: ReadonlySet<string>,
    only?: string | null
): Promise<projects.ProjectSummary[]> {
    const orgId = await scopeOrgIdFor(caller.id);
    return projects.listProjects(caller, orgId, lent, editable, only ? { ids: [only] } : {});
}

/** Whether the reader may change every project these issues sit in. */
async function requireEditableAll(
    caller: projects.TelemetryActor,
    projectIds: readonly string[],
    editable: ReadonlySet<string>,
    manages: boolean
): Promise<void> {
    for (const projectId of new Set(projectIds)) {
        await requireEditable(caller, projectId, editable, manages);
    }
}

export interface IssuePage extends workflow.Page<workflow.IssueListRow> {
    /** The projects on this page the reader may change, so a row offers only
     *  what the server will do. */
    readonly editable: readonly string[];
}

export async function searchIssuesAction(
    input: unknown
): Promise<{ data?: IssuePage; error?: string }> {
    const parsed = q.issueSearchSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.readIssues") };
    const { actor: caller, lent, editable } = await requireTelemetryReader();
    try {
        const visible = await readableProjects(caller, lent, editable, parsed.data.projectId);
        if (parsed.data.projectId && visible.length === 0) {
            await projects.requireProject(caller, parsed.data.projectId, lent);
        }
        const query = q.parseIssueQuery(parsed.data.query);
        const named = query.project?.toLowerCase();
        const chosen = named
            ? visible.filter(
                  (project) =>
                      project.slug.toLowerCase() === named ||
                      project.name.toLowerCase() === named ||
                      project.id === named
              )
            : visible;
        const page = await workflow.searchIssues({
            projects: chosen,
            query,
            sort: parsed.data.sort,
            cursor: parsed.data.cursor,
            viewerId: caller.id
        });
        return {
            data: {
                ...page,
                editable: chosen
                    .filter((project) => project.access !== "view")
                    .map((project) => project.id)
            }
        };
    } catch (caught) {
        return await failure(caught, "errors.readIssues");
    }
}

export async function eventsPageAction(
    input: unknown
): Promise<{ data?: workflow.Page<workflow.EventRow>; error?: string }> {
    const parsed = q.eventPageSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.readEvents") };
    const { actor: caller, lent } = await requireTelemetryReader();
    try {
        await projects.requireProject(caller, parsed.data.projectId, lent);
        return { data: await workflow.listEventsPage(parsed.data) };
    } catch (caught) {
        return await failure(caught, "errors.readEvents");
    }
}

export async function openEventAction(
    input: unknown
): Promise<{ event?: report.EventDetail & { issueId: string }; error?: string }> {
    const parsed = q.eventRefSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.readEvents") };
    const { actor: caller, lent } = await requireTelemetryReader();
    try {
        await projects.requireProject(caller, parsed.data.projectId, lent);
        const event = await workflow.getEvent(parsed.data.projectId, parsed.data.eventId);
        return event ? { event } : { error: await say("errors.eventGone") };
    } catch (caught) {
        return await failure(caught, "errors.readEvents");
    }
}

export async function projectsPageAction(
    input: unknown
): Promise<{ data?: workflow.Page<projects.ProjectSummary & { dsn: string }>; error?: string }> {
    const parsed = q.projectPageSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.readProjects") };
    const { actor: caller, lent, editable } = await requireTelemetryReader();
    try {
        const orgId = await scopeOrgIdFor(caller.id);
        const [rows, origin] = await Promise.all([
            projects.listProjects(caller, orgId, lent, editable, {
                query: parsed.data.query || undefined,
                ...q.pageArgs(parsed.data.cursor, q.PAGE_SIZE)
            }),
            appBaseUrl()
        ]);
        const page = q.pageOf(rows, q.PAGE_SIZE);
        return {
            data: {
                next: page.next,
                items: page.items.map((row) => ({ ...row, dsn: projects.dsnFor(row, origin) }))
            }
        };
    } catch (caught) {
        return await failure(caught, "errors.readProjects");
    }
}

export async function releasesAction(
    input: unknown
): Promise<{ releases?: workflow.ReleaseRow[]; error?: string }> {
    const parsed = q.projectRefSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.readReleases") };
    const { actor: caller, lent } = await requireTelemetryReader();
    try {
        await projects.requireProject(caller, parsed.data.projectId, lent);
        return { releases: await workflow.listReleases(parsed.data.projectId) };
    } catch (caught) {
        return await failure(caught, "errors.readReleases");
    }
}

export async function bulkStatusAction(input: unknown): Promise<{ error?: string }> {
    const parsed = q.bulkStatusSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.badStatus") };
    const { caller, editable, manages } = await editor();
    try {
        const found = await workflow.issuesByIds(parsed.data.issueIds);
        if (found.length === 0) return { error: await say("errors.issueGone") };
        await requireEditableAll(
            caller,
            found.map((issue) => issue.projectId),
            editable,
            manages
        );
        await workflow.setStatusMany(found, parsed.data.status, caller.id, parsed.data.mode);
        revalidatePath(PATH);
        return {};
    } catch (caught) {
        return await failure(caught, "errors.changeIssue");
    }
}

export async function assignIssuesAction(input: unknown): Promise<{ error?: string }> {
    const parsed = q.assignSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.assign") };
    const { caller, editable, manages } = await editor();
    try {
        const found = await workflow.issuesByIds(parsed.data.issueIds);
        if (found.length === 0) return { error: await say("errors.issueGone") };
        const projectIds = found.map((issue) => issue.projectId);
        await requireEditableAll(caller, projectIds, editable, manages);
        const assignee = parsed.data.assigneeId;
        if (assignee) {
            const held = await grantedSubjects(assignee, "telemetry.project");
            if (!(await workflow.mayRead(assignee, projectIds, new Set(held.keys())))) {
                return { error: await say("errors.assigneeCannotSee") };
            }
        }
        await workflow.assignMany(found, assignee, caller.id);
        if (assignee) {
            // The assignment stands whether or not the bell could be rung.
            await workflow
                .notifyAssigned(found, assignee, caller.id)
                .catch((error) => console.error("polaris: could not notify an assignee:", error));
        }
        return {};
    } catch (caught) {
        return await failure(caught, "errors.assign");
    }
}

/** Who an issue can be handed to: anybody the people search finds, greyed out
 *  with the reason when they could not open the project. */
export async function searchAssigneesAction(
    projectId: string,
    query: string
): Promise<{ results?: { id: string; name: string; unavailable?: string }[] }> {
    const parsed = q.projectRefSchema.safeParse({ projectId });
    if (!parsed.success) return { results: [] };
    const { actor: caller, lent } = await requireTelemetryReader();
    const user = await requireUser();
    try {
        await projects.requireProject(caller, parsed.data.projectId, lent);
        const found = await findPeople(user, String(query ?? "").slice(0, 80), {
            reachableOnly: false,
            limit: 10
        });
        const cannot = await say("assign.cannotSee");
        const results = await Promise.all(
            found.people.map(async (person) => {
                const held = await grantedSubjects(person.id, "telemetry.project");
                const may = await workflow.mayRead(
                    person.id,
                    [parsed.data.projectId],
                    new Set(held.keys())
                );
                return may ? person : { ...person, unavailable: cannot };
            })
        );
        return { results };
    } catch (caught) {
        console.error("polaris: a telemetry assignee search failed:", caught);
        return { results: [] };
    }
}

/** The lists a task can be made in, for an account that may make tasks. */
export async function taskListsAction(
    query: string
): Promise<{ lists?: workflow.TaskListOption[]; error?: string }> {
    const user = await requireUser();
    if (!(await sessionCan(user, "tasks.manage"))) return { error: await say("errors.noTasks") };
    try {
        return {
            lists: await workflow.findTaskLists(
                { id: user.id, isAdmin: user.isAdmin },
                String(query ?? "").slice(0, 80)
            )
        };
    } catch (caught) {
        console.error("polaris: reading task lists for telemetry failed:", caught);
        return { error: await say("errors.readLists") };
    }
}

/**
 * Make a task from an issue, in a list the caller may add to, and note it on
 * the issue so the next person to open it sees the work already exists.
 */
export async function createIssueTaskAction(
    input: unknown
): Promise<{ id?: string; reference?: string; error?: string }> {
    const parsed = q.issueTaskSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.taskInput") };
    const { actor: caller, lent } = await requireTelemetryReader();
    const user = await requireUser();
    if (!(await sessionCan(user, "tasks.manage"))) return { error: await say("errors.noTasks") };
    try {
        await projects.requireProject(caller, parsed.data.projectId, lent);
        const meta = await workflow.issueMeta(parsed.data.projectId, parsed.data.issueId);
        if (!meta) return { error: await say("errors.issueGone") };
        const { spaceId } = await taskAccess.requireList(caller, parsed.data.listId, "member");
        const created = await tasks.createTask(
            caller.id,
            spaceId,
            core.taskCreateSchema.parse({
                listId: parsed.data.listId,
                name: parsed.data.name,
                description: parsed.data.description,
                assigneeIds: parsed.data.assign ? [meta.assignee?.id ?? caller.id] : []
            })
        );
        await workflow.addActivity({
            projectId: parsed.data.projectId,
            issueId: parsed.data.issueId,
            actorId: caller.id,
            kind: "task",
            body: `${created.reference} ${parsed.data.name}`.slice(0, 300),
            ref: created.id
        });
        return created;
    } catch (caught) {
        if (caught instanceof taskAccess.TaskAccessError) {
            return { error: await say("errors.listRefused") };
        }
        return await failure(caught, "errors.makeTask");
    }
}

export async function issueActivityAction(
    input: unknown
): Promise<{ data?: workflow.Page<workflow.ActivityRow>; error?: string }> {
    const parsed = q.activityPageSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.readActivity") };
    const { actor: caller, lent } = await requireTelemetryReader();
    try {
        await projects.requireProject(caller, parsed.data.projectId, lent);
        if (!(await workflow.issueMeta(parsed.data.projectId, parsed.data.issueId))) {
            return { error: await say("errors.issueGone") };
        }
        return { data: await workflow.listActivity(parsed.data.issueId, parsed.data.cursor) };
    } catch (caught) {
        return await failure(caught, "errors.readActivity");
    }
}

/** A comment on an issue. Anybody who can read the issue may say something about it. */
export async function commentIssueAction(input: unknown): Promise<{ error?: string }> {
    const parsed = q.commentSchema.safeParse(input);
    if (!parsed.success) return { error: await say("errors.comment") };
    const { actor: caller, lent } = await requireTelemetryReader();
    try {
        await projects.requireProject(caller, parsed.data.projectId, lent);
        if (!(await workflow.issueMeta(parsed.data.projectId, parsed.data.issueId))) {
            return { error: await say("errors.issueGone") };
        }
        await workflow.addActivity({ ...parsed.data, actorId: caller.id, kind: "comment" });
        return {};
    } catch (caught) {
        return await failure(caught, "errors.comment");
    }
}
