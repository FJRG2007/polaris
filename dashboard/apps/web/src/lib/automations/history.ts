/**
 * What an automation did and what it was: the runs list (paged), one run with
 * every step, running again, test runs of the draft, and the published
 * versions with restore.
 *
 * Reads follow `mayReadShelf`, writes `mayEditShelf` (through `load`), the
 * checks the screens use to hide what they would refuse. Step data holds other
 * apps' data, so only editors are sent it (design section 12).
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import type { RunActor } from "./types";
import { randomUUID } from "node:crypto";
import { advanceRun, loadGraph, startRun } from "./engine";
import { mayEditShelf, mayReadShelf, type Shelf } from "./runner";
import { AutomationAccessError, checkSecrets, load, shelfWhere } from "./service";

const L = core.AUTOMATION_LIMITS;

export interface RunRow {
    readonly id: string;
    readonly automationId: string;
    readonly automationName: string;
    readonly status: string;
    readonly finally: string;
    readonly error: string | null;
    readonly queuedAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly canCancel: boolean;
}

export interface RunsPage {
    readonly rows: RunRow[];
    /** Where the next page starts, or null on the last one. */
    readonly next: string | null;
}

export const RUN_FILTERS = ["all", "failed", "succeeded", "active"] as const;
export type RunFilter = (typeof RUN_FILTERS)[number];

function statusWhere(filter: RunFilter) {
    if (filter === "failed") return { status: { in: ["failed", "refused", "timedOut"] } };
    if (filter === "succeeded") return { status: "succeeded" };
    if (filter === "active") return { status: { in: ["queued", "running", "waiting"] } };
    return {};
}

/** A page cursor: the last row's queue time and id, so a page never repeats or skips a row. */
export function readCursor(cursor: string | undefined): { at: Date; id: string } | null {
    if (!cursor) return null;
    const [at, id] = cursor.split("|");
    const date = new Date(at ?? "");
    return id && /^[0-9a-f-]{36}$/i.test(id) && !Number.isNaN(date.getTime()) ? { at: date, id } : null;
}

/** Live runs on a shelf (or of one automation), newest first, one page at a time. */
export async function listRuns(
    actor: RunActor,
    shelf: Shelf,
    automationId?: string,
    page: { cursor?: string; filter?: RunFilter } = {}
): Promise<RunsPage> {
    if (!(await mayReadShelf(actor, shelf))) return { rows: [], next: null };
    const canEdit = await mayEditShelf(actor, shelf);
    const after = readCursor(page.cursor);
    const size = L.runsPage;
    const rows = await prisma.automationRun.findMany({
        where: {
            test: false,
            automation: shelfWhere(shelf),
            ...(automationId ? { automationId } : {}),
            ...statusWhere(page.filter ?? "all"),
            ...(after ? { OR: [{ queuedAt: { lt: after.at } }, { queuedAt: after.at, id: { lt: after.id } }] } : {})
        },
        orderBy: [{ queuedAt: "desc" }, { id: "desc" }],
        take: size + 1,
        select: {
            id: true,
            automationId: true,
            status: true,
            finally: true,
            error: true,
            queuedAt: true,
            startedAt: true,
            finishedAt: true,
            automation: { select: { name: true } }
        }
    });
    const shown = rows.slice(0, size);
    const last = shown.at(-1);
    return {
        next: rows.length > size && last ? `${last.queuedAt.toISOString()}|${last.id}` : null,
        rows: shown.map((row) => ({
            id: row.id,
            automationId: row.automationId,
            automationName: row.automation.name,
            status: row.status,
            finally: row.finally,
            error: row.error,
            queuedAt: row.queuedAt.toISOString(),
            startedAt: row.startedAt?.toISOString() ?? null,
            finishedAt: row.finishedAt?.toISOString() ?? null,
            canCancel: canEdit && !core.runFinished(row.status)
        }))
    };
}

export interface StepView {
    readonly id: string;
    readonly nodeId: string;
    readonly iteration: string;
    readonly attempt: number;
    readonly status: string;
    readonly port: string | null;
    readonly error: string | null;
    /** Null for a reader who may not edit the automation. */
    readonly input: unknown;
    readonly output: unknown;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
}

export interface RunDetail {
    readonly id: string;
    readonly automationId: string;
    readonly automationName: string;
    readonly status: string;
    readonly finally: string;
    readonly error: string | null;
    readonly test: boolean;
    /** Null for a test run, whose snapshot is not in the history. */
    readonly versionNumber: number | null;
    readonly triggerNodeId: string;
    readonly queuedAt: string;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
    readonly graph: core.AutomationGraph | null;
    readonly steps: StepView[];
    readonly canSeeData: boolean;
    readonly canCancel: boolean;
    /** Whether "Run again" can start: an editor, a live run, an automation switched on. */
    readonly canRerun: boolean;
}

/** One run with every step, for the run view and the canvas. */
export async function getRun(actor: RunActor, runId: string): Promise<RunDetail> {
    const run = await prisma.automationRun.findUnique({
        where: { id: runId },
        select: {
            id: true,
            automationId: true,
            versionId: true,
            status: true,
            finally: true,
            error: true,
            test: true,
            triggerNodeId: true,
            queuedAt: true,
            startedAt: true,
            finishedAt: true
        }
    });
    if (!run) throw new AutomationAccessError("notFound");
    const row = await load(actor, run.automationId, false);
    const canEdit = await mayEditShelf(actor, row);
    // A test run of the draft is the editor's business only.
    if (run.test && !canEdit) throw new AutomationAccessError("notFound");
    const [steps, version, graph] = await Promise.all([
        prisma.automationStep.findMany({
            where: { runId },
            orderBy: [{ createdAt: "asc" }, { id: "asc" }],
            take: L.stepsPerRun + 10,
            select: {
                id: true,
                nodeId: true,
                iteration: true,
                attempt: true,
                status: true,
                port: true,
                error: true,
                input: canEdit,
                output: canEdit,
                startedAt: true,
                finishedAt: true
            }
        }),
        prisma.automationVersion.findUnique({ where: { id: run.versionId }, select: { number: true } }),
        loadGraph(run.versionId)
    ]);
    return {
        id: run.id,
        automationId: run.automationId,
        automationName: row.name,
        status: run.status,
        finally: run.finally,
        error: run.error,
        test: run.test,
        versionNumber: version && version.number > 0 ? version.number : null,
        triggerNodeId: run.triggerNodeId,
        queuedAt: run.queuedAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
        graph,
        canSeeData: canEdit,
        canCancel: canEdit && !core.runFinished(run.status),
        canRerun: canEdit && !run.test && row.enabled && row.publishedVersionId !== null,
        steps: steps.map((step) => {
            const data = step as { input?: unknown; output?: unknown };
            return {
                id: step.id,
                nodeId: step.nodeId,
                iteration: step.iteration,
                attempt: step.attempt,
                status: step.status,
                port: step.port,
                error: step.error,
                input: canEdit ? (data.input ?? null) : null,
                output: canEdit ? (data.output ?? null) : null,
                startedAt: step.startedAt?.toISOString() ?? null,
                finishedAt: step.finishedAt?.toISOString() ?? null
            };
        })
    };
}

function kick(runId: string): void {
    void advanceRun(runId).catch((caught) => console.error("polaris: an automation run failed to step:", caught));
}

/**
 * Run a live run again with the trigger data it had, on the version it ran
 * ("same") or on the one live now ("published"). It is a new run, admitted by
 * the automation's mode and rate limit like any other.
 */
export async function rerun(actor: RunActor, runId: string, which: "same" | "published"): Promise<string> {
    const run = await prisma.automationRun.findUnique({
        where: { id: runId },
        select: { automationId: true, versionId: true, triggerNodeId: true, cause: true, test: true }
    });
    if (!run || run.test) throw new AutomationAccessError("notFound");
    const row = await load(actor, run.automationId, true);
    if (!row.enabled || !row.publishedVersionId) throw new AutomationAccessError("notPublished");
    const versionId = which === "same" ? run.versionId : row.publishedVersionId;
    const graph = await loadGraph(versionId);
    if (!graph?.nodes.some((node) => node.id === run.triggerNodeId)) throw new AutomationAccessError("triggerGone");
    const started = await startRun({
        automationId: run.automationId,
        versionId,
        triggerNodeId: run.triggerNodeId,
        firingKey: `rerun:${randomUUID()}`,
        cause: { ...((run.cause ?? {}) as Record<string, unknown>), at: new Date().toISOString() },
        depth: 0
    });
    if (!started) throw new AutomationAccessError("notFound");
    if (started.status === "running") kick(started.id);
    return started.id;
}

/** A pinned sample as trigger data: an object as it is, anything else under `value`. */
export function pinnedCause(pinned: unknown): Record<string, unknown> {
    return pinned && typeof pinned === "object" && !Array.isArray(pinned) ? { ...(pinned as Record<string, unknown>) } : { value: pinned };
}

/**
 * Test the saved draft: a run marked as a test, from `triggerNodeId` (or the
 * first trigger) with that trigger's pinned sample as its data, using every
 * other pinned sample instead of running that node. Nodes without a pin really
 * run; the editor says so on the button.
 */
export async function startTestRun(
    actor: RunActor,
    id: string,
    triggerNodeId?: string
): Promise<{ runId: string } | { problems: core.GraphProblem[] }> {
    const row = await load(actor, id, true);
    const parsed = core.automationGraphSchema.safeParse(row.draft);
    if (!parsed.success) throw new AutomationAccessError("invalid");
    const problems = core.graphProblems(parsed.data, { forPublish: true });
    if (problems.length > 0) return { problems };
    await checkSecrets(row, parsed.data);
    const triggers = core.triggerNodes(parsed.data);
    const trigger = triggerNodeId ? triggers.find((node) => node.id === triggerNodeId) : triggers[0];
    if (!trigger) throw new AutomationAccessError("noTrigger");

    // The snapshot a test runs is an immutable version too, numbered below zero
    // so the history (1, 2, ...) and the next publish never see it.
    let versionId: string | null = null;
    for (let attempt = 0; attempt < 3 && !versionId; attempt++) {
        const lowest = await prisma.automationVersion.findFirst({
            where: { automationId: id, number: { lt: 0 } },
            orderBy: { number: "asc" },
            select: { number: true }
        });
        try {
            const created = await prisma.automationVersion.create({
                data: { automationId: id, number: (lowest?.number ?? 0) - 1, graph: parsed.data as object, savedById: actor.id },
                select: { id: true }
            });
            versionId = created.id;
        } catch (caught) {
            if ((caught as { code?: string } | null)?.code !== "P2002") throw caught;
        }
    }
    if (!versionId) throw new AutomationAccessError("invalid");
    const started = await startRun({
        automationId: id,
        versionId,
        triggerNodeId: trigger.id,
        firingKey: `test:${randomUUID()}`,
        cause: {
            ...(trigger.pinned !== undefined ? pinnedCause(trigger.pinned) : { kind: "test", by: actor.id }),
            id: trigger.id,
            at: new Date().toISOString()
        },
        depth: 0,
        test: true
    });
    if (!started) throw new AutomationAccessError("notFound");
    await pruneTestRuns(id);
    kick(started.id);
    return { runId: started.id };
}

/** Keep the newest test runs and the snapshots they ran, nothing older. Bounded. */
async function pruneTestRuns(automationId: string): Promise<void> {
    const old = await prisma.automationRun.findMany({
        where: { automationId, test: true },
        orderBy: [{ queuedAt: "desc" }, { id: "desc" }],
        skip: L.keepTestRuns,
        take: 50,
        select: { id: true }
    });
    if (old.length > 0) await prisma.automationRun.deleteMany({ where: { id: { in: old.map((run) => run.id) } } });
    const kept = await prisma.automationRun.findMany({
        where: { automationId, test: true },
        take: L.keepTestRuns + 50,
        select: { versionId: true }
    });
    await prisma.automationVersion.deleteMany({
        where: { automationId, number: { lt: 0 }, id: { notIn: kept.map((run) => run.versionId) } }
    });
}

export interface VersionRow {
    readonly id: string;
    readonly number: number;
    readonly name: string | null;
    readonly createdAt: string;
    readonly savedBy: string | null;
    readonly live: boolean;
}

/** Published versions, newest first. Every one is kept; the list shows the newest. */
export async function listVersions(actor: RunActor, id: string): Promise<VersionRow[]> {
    const row = await load(actor, id, false);
    const versions = await prisma.automationVersion.findMany({
        where: { automationId: id, number: { gt: 0 } },
        orderBy: { number: "desc" },
        take: L.versionsListed,
        select: { id: true, number: true, name: true, createdAt: true, savedById: true }
    });
    const people = [...new Set(versions.map((version) => version.savedById).filter((value): value is string => Boolean(value)))];
    const names = people.length
        ? await prisma.user.findMany({ where: { id: { in: people } }, select: { id: true, name: true }, take: people.length })
        : [];
    const byId = new Map(names.map((person) => [person.id, person.name]));
    return versions.map((version) => ({
        id: version.id,
        number: version.number,
        name: version.name,
        createdAt: version.createdAt.toISOString(),
        savedBy: version.savedById ? (byId.get(version.savedById) ?? null) : null,
        live: version.id === row.publishedVersionId
    }));
}

/** Put a published version back into the draft. The live version stays as it is until the next publish. */
export async function restoreVersion(actor: RunActor, id: string, versionId: string): Promise<core.AutomationGraph> {
    await load(actor, id, true);
    const version = await prisma.automationVersion.findUnique({
        where: { id: versionId },
        select: { automationId: true, number: true, graph: true }
    });
    if (!version || version.automationId !== id || version.number <= 0) throw new AutomationAccessError("notFound");
    const parsed = core.automationGraphSchema.safeParse(version.graph);
    if (!parsed.success) throw new AutomationAccessError("invalid");
    await prisma.automation.update({ where: { id }, data: { draft: parsed.data as object, draftUpdatedAt: new Date() } });
    return parsed.data;
}
