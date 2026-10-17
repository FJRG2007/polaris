/**
 * What an app asks of the automations engine, through the app host.
 *
 * An app whose triggers are stateful (Places: held for a while, any or all of a
 * set, a reading crossing a line, the sun) decides for itself when one fires,
 * with its own evaluators, and hands the firing here; the run, its steps, its
 * mode and its rate limit are the engine's. An app moving its own automations
 * here imports each one once, keyed by its `legacyRef`.
 *
 * An app that is not installed asks nothing - its jobs do not run - so its
 * triggers stay stored and simply never fire until it is back.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import { fireTrigger } from "./combine";
import { armVersion } from "./triggers";
import { graphProblems } from "./node-registry";
import { advanceRun, loadGraph, resumeDueWaits, RECHECK_PREFIX } from "./engine";

const L = core.AUTOMATION_LIMITS;

const appId = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);

/** One armed trigger of an app's node type, on a published, enabled automation. */
export interface AppTriggerRow {
    readonly automationId: string;
    readonly versionId: string;
    readonly nodeId: string;
    readonly type: string;
    readonly config: unknown;
    readonly name: string;
    readonly timeZone: string;
    /** When the version that armed it was published: a time of day before it was not missed. */
    readonly armedAt: Date;
    readonly runAsId: string | null;
    readonly legacyRef: string | null;
}

/** One stored trigger of an app's node type, as a page reads it. */
interface StoredTrigger {
    readonly id: string;
    readonly nodeId: string;
    readonly versionId: string;
    readonly eventType: string;
    readonly automation: {
        readonly id: string;
        readonly name: string;
        readonly enabled: boolean;
        readonly publishedVersionId: string | null;
        readonly runAsId: string | null;
        readonly legacyRef: string | null;
    };
}

/** Every armed trigger of one app's node types, read a page at a time. */
export async function appTriggers(app: string): Promise<AppTriggerRow[]> {
    const prefix = `${appId.parse(app)}.trigger.`;
    const out: AppTriggerRow[] = [];
    let after: string | null = null;
    for (;;) {
        const rows: StoredTrigger[] = await prisma.automationTrigger.findMany({
            where: {
                eventType: { startsWith: prefix },
                automation: { enabled: true, publishedVersionId: { not: null } },
                ...(after ? { id: { gt: after } } : {})
            },
            orderBy: { id: "asc" },
            take: L.perShelf,
            select: {
                id: true,
                nodeId: true,
                versionId: true,
                eventType: true,
                automation: {
                    select: {
                        id: true,
                        name: true,
                        enabled: true,
                        publishedVersionId: true,
                        runAsId: true,
                        legacyRef: true
                    }
                }
            }
        });
        out.push(...(await armedOf(rows)));
        if (rows.length < L.perShelf) return out;
        after = rows[rows.length - 1]!.id;
    }
}

/** The rows of one page that the published version armed, with their node's config. */
async function armedOf(rows: readonly StoredTrigger[]): Promise<AppTriggerRow[]> {
    const live = rows.filter(
        (row) => row.automation.enabled && row.automation.publishedVersionId === row.versionId
    );
    if (live.length === 0) return [];
    const versions = await prisma.automationVersion.findMany({
        where: { id: { in: [...new Set(live.map((row) => row.versionId))] } },
        select: { id: true, createdAt: true, graph: true }
    });
    const byId = new Map(versions.map((version) => [version.id, version]));
    const out: AppTriggerRow[] = [];
    for (const row of live) {
        const version = byId.get(row.versionId);
        const graph = core.automationGraphSchema.safeParse(version?.graph);
        const node = graph.success
            ? graph.data.nodes.find((entry) => entry.id === row.nodeId)
            : undefined;
        if (!version || !graph.success || !node) continue;
        out.push({
            automationId: row.automation.id,
            versionId: row.versionId,
            nodeId: row.nodeId,
            type: row.eventType,
            config: node.config,
            name: row.automation.name,
            timeZone: graph.data.timeZone,
            armedAt: version.createdAt,
            runAsId: row.automation.runAsId,
            legacyRef: row.automation.legacyRef
        });
    }
    return out;
}

const fireInput = z.object({
    automationId: z.string().uuid(),
    /** Absent: the automation's first trigger (a run started by another automation). */
    nodeId: z.string().min(1).max(64).optional(),
    firingKey: z.string().min(1).max(200),
    cause: z.record(z.unknown()),
    depth: z.number().int().min(0).max(100)
});

/** Start a run of a published automation from one of its triggers. False when nothing started. */
export async function fireAppTrigger(input: z.input<typeof fireInput>): Promise<boolean> {
    const firing = fireInput.parse(input);
    const automation = await prisma.automation.findUnique({
        where: { id: firing.automationId },
        select: { enabled: true, publishedVersionId: true }
    });
    if (!automation?.enabled || !automation.publishedVersionId) return false;
    const graph = await loadGraph(automation.publishedVersionId);
    const triggers = graph ? core.triggerNodes(graph).filter((node) => node.enabled !== false) : [];
    const node = firing.nodeId
        ? triggers.find((entry) => entry.id === firing.nodeId)
        : triggers[0];
    if (!node) return false;
    const run = await fireTrigger({
        automationId: firing.automationId,
        versionId: automation.publishedVersionId,
        triggerNodeId: node.id,
        firingKey: firing.firingKey,
        cause: { ...firing.cause, id: node.id },
        depth: firing.depth
    });
    if (run?.status === "running")
        void advanceRun(run.id).catch((caught) =>
            console.error("polaris: an automation run failed to step:", caught)
        );
    return run !== null;
}

/** Something an app watches changed: every step of its waiting on it looks again now. */
export async function wakeAppWaits(app: string): Promise<void> {
    const woken = await prisma.automationStep.updateMany({
        where: { status: "waiting", waitKey: `${RECHECK_PREFIX}${appId.parse(app)}` },
        data: { waitUntil: new Date() }
    });
    if (woken.count === 0) return;
    for (const id of await resumeDueWaits())
        void advanceRun(id).catch((caught) =>
            console.error("polaris: an automation run failed to step:", caught)
        );
}

const importInput = z.object({
    legacyRef: z.string().min(3).max(120),
    name: z.string().min(1).max(200),
    enabled: z.boolean(),
    /** Whose rights it keeps acting with; their personal shelf holds it. */
    ownerId: z.string().uuid(),
    origin: appId,
    originRef: z.string().max(120).nullable(),
    mode: z.enum(core.AUTOMATION_MODES),
    graph: z.unknown()
});

/**
 * Bring one of an app's own automations here, once: the same `legacyRef` twice
 * answers the first one's id, so a move that crashed half-way is simply run
 * again. The graph is published as version 1 and armed.
 */
export async function importLegacyAutomation(input: z.input<typeof importInput>): Promise<string> {
    const given = importInput.parse(input);
    const existing = await prisma.automation.findUnique({
        where: { legacyRef: given.legacyRef },
        select: { id: true }
    });
    if (existing) return existing.id;
    const graph = core.automationGraphSchema.parse(given.graph);
    if ((await graphProblems(graph, { forPublish: true })).length > 0)
        throw new Error("an imported automation must be one that can be published");
    let id: string;
    try {
        id = await prisma.$transaction(async (tx) => {
            const row = await tx.automation.create({
                data: {
                    userId: given.ownerId,
                    name: given.name,
                    description: "",
                    draft: graph as object,
                    enabled: given.enabled,
                    runAsId: given.ownerId,
                    mode: given.mode,
                    maxRuns: core.DEFAULT_MAX_RUNS,
                    rateLimit: core.DEFAULT_RATE_LIMIT,
                    origin: given.origin,
                    originRef: given.originRef,
                    legacyRef: given.legacyRef
                },
                select: { id: true }
            });
            const version = await tx.automationVersion.create({
                data: {
                    automationId: row.id,
                    number: 1,
                    graph: graph as object,
                    savedById: given.ownerId
                },
                select: { id: true }
            });
            await tx.automation.update({
                where: { id: row.id },
                data: { publishedVersionId: version.id, draftUpdatedAt: new Date() }
            });
            return row.id;
        });
    } catch (caught) {
        // Another process imported it first.
        if ((caught as { code?: string } | null)?.code !== "P2002") throw caught;
        const raced = await prisma.automation.findUnique({
            where: { legacyRef: given.legacyRef },
            select: { id: true }
        });
        if (!raced) throw caught;
        return raced.id;
    }
    const published = await prisma.automation.findUnique({
        where: { id },
        select: { publishedVersionId: true }
    });
    if (published?.publishedVersionId) await armVersion(id, published.publishedVersionId, graph);
    return id;
}

/** The central automation a moved row became, by its `legacyRef`. */
export async function automationForLegacy(legacyRef: string): Promise<string | null> {
    const row = await prisma.automation.findUnique({
        where: { legacyRef: z.string().min(3).max(120).parse(legacyRef) },
        select: { id: true }
    });
    return row?.id ?? null;
}

/** Many at once, for rewriting "run another automation" steps. */
export async function automationsForLegacy(
    legacyRefs: readonly string[]
): Promise<Record<string, string>> {
    const refs = z.array(z.string().min(3).max(120)).max(1000).parse(legacyRefs);
    const rows = await prisma.automation.findMany({
        where: { legacyRef: { in: refs } },
        select: { id: true, legacyRef: true }
    });
    return Object.fromEntries(rows.map((row) => [row.legacyRef!, row.id]));
}

/** What an app's own list shows of a moved automation, read where it now lives. */
export interface LegacySummary {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly lastRunAt: string | null;
    readonly lastStatus: string | null;
}

/** The central side of many moved rows at once, by `legacyRef`. */
export async function legacySummaries(
    legacyRefs: readonly string[]
): Promise<Record<string, LegacySummary>> {
    const refs = z.array(z.string().min(3).max(120)).max(1000).parse(legacyRefs);
    if (refs.length === 0) return {};
    const rows = await prisma.automation.findMany({
        where: { legacyRef: { in: refs } },
        select: {
            id: true,
            legacyRef: true,
            name: true,
            enabled: true,
            lastRunAt: true,
            lastStatus: true
        }
    });
    return Object.fromEntries(
        rows.map((row) => [
            row.legacyRef!,
            {
                id: row.id,
                name: row.name,
                enabled: row.enabled,
                lastRunAt: row.lastRunAt?.toISOString() ?? null,
                lastStatus: row.lastStatus
            }
        ])
    );
}
