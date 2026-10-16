/**
 * Automations as the screens see them: listing a shelf, editing a draft,
 * publishing, switching on and off, running by hand, and the runs list.
 *
 * Every write checks `mayEditShelf`, the same check the screens use to hide
 * what they would refuse, and every read is bounded.
 */

import { prisma } from "@polaris/db";
import { cancelRun } from "./engine";
import * as core from "@polaris/core";
import type { RunActor } from "./types";
import { randomUUID } from "node:crypto";
import { recordAudit } from "@/lib/audit-service";
import { emitAutomationEvent, kickIntake } from "./outbox";
import { armVersion, disarm, hookPath, manualSubject } from "./triggers";
import { mayAllowLocalNetwork, mayEditShelf, mayReadShelf, type Shelf } from "./runner";

const L = core.AUTOMATION_LIMITS;

/** A refusal the screens put into words by its code. */
export class AutomationAccessError extends Error {
    constructor(readonly code: "notFound" | "forbidden" | "limit" | "invalid" | "notPublished" | "noManualTrigger" | "secretMissing") {
        super(code);
        this.name = "AutomationAccessError";
    }
}

function shelfWhere(shelf: Shelf) {
    return shelf.orgId ? { orgId: shelf.orgId } : { userId: shelf.userId, orgId: null };
}

export interface AutomationRow {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly enabled: boolean;
    readonly published: boolean;
    readonly mode: string;
    readonly lastRunAt: string | null;
    readonly lastStatus: string | null;
    readonly updatedAt: string;
}

export async function listAutomations(actor: RunActor, shelf: Shelf): Promise<{ rows: AutomationRow[]; canEdit: boolean }> {
    if (!(await mayReadShelf(actor, shelf))) return { rows: [], canEdit: false };
    const rows = await prisma.automation.findMany({
        where: shelfWhere(shelf),
        orderBy: { updatedAt: "desc" },
        take: L.perShelf,
        select: {
            id: true,
            name: true,
            description: true,
            enabled: true,
            publishedVersionId: true,
            mode: true,
            lastRunAt: true,
            lastStatus: true,
            updatedAt: true
        }
    });
    return {
        canEdit: await mayEditShelf(actor, shelf),
        rows: rows.map((row) => ({
            id: row.id,
            name: row.name,
            description: row.description,
            enabled: row.enabled,
            published: row.publishedVersionId !== null,
            mode: row.mode,
            lastRunAt: row.lastRunAt?.toISOString() ?? null,
            lastStatus: row.lastStatus,
            updatedAt: row.updatedAt.toISOString()
        }))
    };
}

async function load(actor: RunActor, id: string, write: boolean) {
    const row = await prisma.automation.findUnique({
        where: { id },
        select: {
            id: true,
            orgId: true,
            userId: true,
            name: true,
            description: true,
            enabled: true,
            draft: true,
            publishedVersionId: true,
            mode: true,
            maxRuns: true,
            rateLimit: true,
            allowLocalNetwork: true,
            runAsId: true,
            updatedAt: true
        }
    });
    if (!row || !(await mayReadShelf(actor, row))) throw new AutomationAccessError("notFound");
    if (write && !(await mayEditShelf(actor, row))) throw new AutomationAccessError("forbidden");
    return row;
}

export interface AutomationDetail {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly enabled: boolean;
    readonly published: boolean;
    readonly mode: core.AutomationMode;
    readonly maxRuns: number;
    readonly rateLimit: number;
    readonly allowLocalNetwork: boolean;
    readonly canEdit: boolean;
    /** Null when this reader may change the local network switch, else why not. */
    readonly localNetworkRefusal: "orgAdminOnly" | "instanceAdminOnly" | null;
    readonly draft: core.AutomationGraph;
    /** The path of each webhook trigger's address, by node id. Shown only to editors. */
    readonly hooks: Readonly<Record<string, string>>;
    readonly isOrg: boolean;
}

export async function getAutomation(actor: RunActor, id: string): Promise<AutomationDetail> {
    const row = await load(actor, id, false);
    const canEdit = await mayEditShelf(actor, row);
    const parsed = core.automationGraphSchema.safeParse(row.draft);
    const draft = parsed.success ? parsed.data : core.emptyGraph();
    const hooks: Record<string, string> = {};
    if (canEdit)
        for (const node of draft.nodes)
            if (node.type === "core.webhook") {
                const config = core.CORE_NODE_CONFIGS["core.webhook"].safeParse(node.config);
                hooks[node.id] = hookPath(row.id, node.id, config.success ? config.data.rotation : 0);
            }
    const lanAllowed = await mayAllowLocalNetwork(actor, row);
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        enabled: row.enabled,
        published: row.publishedVersionId !== null,
        mode: (core.AUTOMATION_MODES as readonly string[]).includes(row.mode) ? (row.mode as core.AutomationMode) : "single",
        maxRuns: row.maxRuns,
        rateLimit: row.rateLimit,
        allowLocalNetwork: row.allowLocalNetwork,
        canEdit,
        localNetworkRefusal: lanAllowed ? null : row.orgId ? "orgAdminOnly" : "instanceAdminOnly",
        draft,
        hooks,
        isOrg: row.orgId !== null
    };
}

export async function shelfOf(id: string): Promise<Shelf> {
    const row = await prisma.automation.findUnique({ where: { id }, select: { orgId: true, userId: true } });
    if (!row) throw new AutomationAccessError("notFound");
    return row;
}

export async function createAutomation(
    actor: RunActor,
    input: { name: string; description: string; orgId: string | null },
    timeZone: string
): Promise<string> {
    const shelf: Shelf = { orgId: input.orgId, userId: input.orgId ? null : actor.id };
    if (!(await mayEditShelf(actor, shelf))) throw new AutomationAccessError("forbidden");
    if ((await prisma.automation.count({ where: shelfWhere(shelf) })) >= L.perShelf) throw new AutomationAccessError("limit");
    const graph = core.emptyGraph(timeZone);
    graph.nodes.push({ id: core.automationNodeId(), type: "core.manual", typeVersion: 1, config: {} });
    const row = await prisma.automation.create({
        data: {
            orgId: shelf.orgId,
            userId: shelf.userId,
            name: input.name,
            description: input.description,
            draft: graph as object,
            mode: core.DEFAULT_AUTOMATION_MODE,
            maxRuns: core.DEFAULT_MAX_RUNS,
            rateLimit: core.DEFAULT_RATE_LIMIT
        },
        select: { id: true }
    });
    return row.id;
}

/** Secrets the graph names must be the automation's own shelf's. */
async function checkSecrets(shelf: Shelf, graph: core.AutomationGraph): Promise<void> {
    const ids = new Set<string>();
    const collect = (value: unknown, key?: string) => {
        if (typeof value === "string" && (key === "secretId" || key === "urlSecretId")) ids.add(value);
        else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) collect(v, k);
    };
    for (const node of graph.nodes) collect(node.config);
    if (ids.size === 0) return;
    const found = await prisma.automationSecret.count({ where: { id: { in: [...ids] }, ...shelfWhere(shelf) } });
    if (found !== ids.size) throw new AutomationAccessError("secretMissing");
}

export async function saveDraft(actor: RunActor, id: string, graph: core.AutomationGraph): Promise<core.GraphProblem[]> {
    const row = await load(actor, id, true);
    const problems = core.graphProblems(graph);
    if (problems.some((problem) => problem.code !== "badConfig")) return problems;
    await checkSecrets(row, graph);
    await prisma.automation.update({ where: { id }, data: { draft: graph as object, draftUpdatedAt: new Date() } });
    return problems;
}

/** Make the draft live: a new immutable version, armed, running as whoever published it. */
export async function publishAutomation(actor: RunActor, id: string): Promise<core.GraphProblem[]> {
    const row = await load(actor, id, true);
    const parsed = core.automationGraphSchema.safeParse(row.draft);
    if (!parsed.success) throw new AutomationAccessError("invalid");
    const problems = core.graphProblems(parsed.data, { forPublish: true });
    if (problems.length > 0) return problems;
    await checkSecrets(row, parsed.data);
    const last = await prisma.automationVersion.findFirst({
        where: { automationId: id },
        orderBy: { number: "desc" },
        select: { number: true }
    });
    const version = await prisma.automationVersion.create({
        data: { automationId: id, number: (last?.number ?? 0) + 1, graph: parsed.data as object, savedById: actor.id },
        select: { id: true }
    });
    await prisma.automation.update({
        where: { id },
        data: { publishedVersionId: version.id, runAsId: actor.id, enabled: true }
    });
    await armVersion(id, version.id, parsed.data);
    return [];
}

export async function setEnabled(actor: RunActor, id: string, enabled: boolean): Promise<void> {
    const row = await load(actor, id, true);
    if (enabled && !row.publishedVersionId) throw new AutomationAccessError("notPublished");
    await prisma.automation.update({ where: { id }, data: { enabled } });
    if (!enabled) return disarm(id);
    const version = await prisma.automationVersion.findUnique({ where: { id: row.publishedVersionId! }, select: { graph: true } });
    const graph = core.automationGraphSchema.safeParse(version?.graph);
    if (graph.success) await armVersion(id, row.publishedVersionId!, graph.data);
}

export async function updateSettings(
    actor: RunActor,
    id: string,
    settings: { name: string; description: string; mode: core.AutomationMode; maxRuns: number; rateLimit: number }
): Promise<void> {
    await load(actor, id, true);
    await prisma.automation.update({ where: { id }, data: settings });
}

/** The local network switch: administrators only, and every change is audited. */
export async function setLocalNetwork(actor: RunActor, id: string, allow: boolean): Promise<void> {
    const row = await load(actor, id, true);
    if (!(await mayAllowLocalNetwork(actor, row))) throw new AutomationAccessError("forbidden");
    if (row.allowLocalNetwork === allow) return;
    await prisma.automation.update({ where: { id }, data: { allowLocalNetwork: allow } });
    await recordAudit({
        actorId: actor.id,
        action: allow ? "automations.localNetwork.allowed" : "automations.localNetwork.blocked",
        targetType: "automation",
        targetId: id,
        metadata: { name: row.name },
        ...(row.orgId ? { orgId: row.orgId } : {})
    });
}

export async function deleteAutomation(actor: RunActor, id: string): Promise<void> {
    await load(actor, id, true);
    await prisma.automation.delete({ where: { id } });
}

/** Run the published version by hand, through its first "Run by hand" trigger. */
export async function runNow(actor: RunActor, id: string): Promise<void> {
    const row = await load(actor, id, true);
    if (!row.publishedVersionId || !row.enabled) throw new AutomationAccessError("notPublished");
    const trigger = await prisma.automationTrigger.findFirst({
        where: { automationId: id, eventType: "core.manual", versionId: row.publishedVersionId },
        select: { nodeId: true }
    });
    if (!trigger) throw new AutomationAccessError("noManualTrigger");
    await emitAutomationEvent("core.manual", {
        orgId: row.orgId,
        userId: row.userId,
        subjectKey: manualSubject(id, trigger.nodeId),
        payload: { by: actor.id, kind: "manual" },
        dedupeKey: randomUUID()
    });
    await kickIntake();
}

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

export async function listRuns(actor: RunActor, shelf: Shelf, automationId?: string): Promise<RunRow[]> {
    if (!(await mayReadShelf(actor, shelf))) return [];
    const canEdit = await mayEditShelf(actor, shelf);
    const rows = await prisma.automationRun.findMany({
        where: { test: false, automation: shelfWhere(shelf), ...(automationId ? { automationId } : {}) },
        orderBy: { queuedAt: "desc" },
        take: 100,
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
    return rows.map((row) => ({
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
    }));
}

export async function cancelRunFor(actor: RunActor, runId: string): Promise<void> {
    const run = await prisma.automationRun.findUnique({ where: { id: runId }, select: { automationId: true } });
    if (!run) throw new AutomationAccessError("notFound");
    await load(actor, run.automationId, true);
    await cancelRun(runId, "cancelledByPerson");
}
