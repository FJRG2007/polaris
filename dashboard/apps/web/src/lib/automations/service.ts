/**
 * Automations as the screens see them: listing a shelf, editing a draft,
 * publishing, switching on and off, running by hand, and the runs list.
 *
 * Every write checks `mayEditShelf`, the same check the screens use to hide
 * what they would refuse, and every read is bounded.
 */

import type { AppSlot } from "@/lib/app-extensions/types";
import { prisma } from "@polaris/db";
import { cancelRun, loadGraph } from "./engine";
import * as core from "@polaris/core";
import type { RunActor } from "./types";
import { isUuid } from "@/lib/uuid";
import { randomUUID } from "node:crypto";
import { recordAudit } from "@/lib/audit-service";
import { emitAutomationEvent, kickIntake } from "./outbox";
import { armVersion, disarm, hookPath, manualSubject } from "./triggers";
import { callCycle } from "./calls";
import { graphProblems } from "./node-registry";
import { mayAllowLocalNetwork, mayEditShelf, mayReadShelf, type Shelf } from "./runner";
import { AutomationAccessError } from "./access-error";
import { checkChatWebhooks } from "./chat-webhooks";
import { checkNoticeTargets } from "./notice-targets";
import { dropGrantsFor, grantedSubjects } from "@/lib/access/grants";

export { AutomationAccessError };

const L = core.AUTOMATION_LIMITS;
const OTHERS_LISTED = 1000;

export function shelfWhere(shelf: Shelf) {
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
    readonly folderId: string | null;
    readonly tags: readonly string[];
    /** Whether Run now would start it: switched on, published, with a Run by
     *  hand trigger in what is published. Absent on a list cached before. */
    readonly runnable?: boolean;
    /** Somebody else's automation, shared with this reader to look at. */
    readonly shared?: boolean;
}

/** The app an automation came from, and the thing of that app it belongs to - a place. */
export interface OriginFilter {
    readonly origin: string;
    readonly originRef?: string | null;
}

export async function listAutomations(
    actor: RunActor,
    shelf: Shelf,
    from?: OriginFilter
): Promise<{ rows: AutomationRow[]; canEdit: boolean }> {
    if (!(await mayReadShelf(actor, shelf))) return { rows: [], canEdit: false };
    // Automations shared with this reader are listed on their personal shelf.
    const lent =
        !shelf.orgId && !from
            ? [...(await grantedSubjects(actor.id, "automation.automation")).keys()]
            : [];
    const rows = await prisma.automation.findMany({
        where: {
            ...(lent.length
                ? { OR: [shelfWhere(shelf), { id: { in: lent } }] }
                : shelfWhere(shelf)),
            ...(from
                ? { origin: from.origin, ...(from.originRef ? { originRef: from.originRef } : {}) }
                : {})
        },
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
            updatedAt: true,
            folderId: true,
            tags: true,
            orgId: true,
            userId: true
        }
    });
    const own = (row: { orgId: string | null; userId: string | null }) =>
        shelf.orgId ? row.orgId === shelf.orgId : !row.orgId && row.userId === shelf.userId;
    const live = rows.flatMap((row) =>
        row.enabled && row.publishedVersionId ? [row.publishedVersionId] : []
    );
    const manual = live.length
        ? await prisma.automationTrigger.findMany({
              where: {
                  automationId: { in: rows.map((row) => row.id) },
                  versionId: { in: live },
                  eventType: "core.manual"
              },
              select: { versionId: true }
          })
        : [];
    const runnable = new Set(manual.map((trigger) => trigger.versionId));
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
            updatedAt: row.updatedAt.toISOString(),
            // A shared one is not filed in this reader's folders.
            folderId: own(row) ? row.folderId : null,
            tags: row.tags ?? [],
            ...(own(row) ? {} : { shared: true }),
            runnable:
                row.enabled &&
                row.publishedVersionId !== null &&
                runnable.has(row.publishedVersionId)
        }))
    };
}

export async function load(actor: RunActor, id: string, write: boolean) {
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
            origin: true,
            originRef: true,
            updatedAt: true
        }
    });
    if (!row) throw new AutomationAccessError("notFound");
    if (!(await mayReadShelf(actor, row))) {
        // Shared with this reader: looked at, never changed.
        const held = await grantedSubjects(actor.id, "automation.automation");
        if (!held.has(row.id)) throw new AutomationAccessError("notFound");
        if (write) throw new AutomationAccessError("forbidden");
        return row;
    }
    if (write && !(await mayEditShelf(actor, row))) throw new AutomationAccessError("forbidden");
    return row;
}

export interface AutomationDetail {
    /** Where installed apps draw their nodes' settings, by app id; filled in by the screen's action. */
    readonly appNodes?: Readonly<Record<string, AppSlot>>;
    /** The apps whose events this viewer may start automations on; filled in by the screen's action. */
    readonly eventApps?: readonly core.AppEventApp[];
    /** Still under the name it was created with, in any language; filled in by the screen's action. */
    readonly unnamed?: boolean;
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
    /** The app that made it and the thing of that app it belongs to, such as a
     *  place; null for one made here. Its list is filtered to them. */
    readonly origin: string | null;
    readonly originRef: string | null;
    /** The live version, to tell the draft from it. */
    readonly publishedVersion: {
        readonly id: string;
        readonly number: number;
        readonly graph: core.AutomationGraph;
    } | null;
    /** The newest test run of the draft, whose outputs the canvas shows on each node. */
    readonly lastTestRunId: string | null;
    /** The other automations on the same shelf: what Run another automation and An automation failed can name. */
    readonly others: readonly { readonly id: string; readonly name: string }[];
}

export async function getAutomation(actor: RunActor, id: string): Promise<AutomationDetail> {
    const row = await load(actor, id, false);
    const canEdit = await mayEditShelf(actor, row);
    const parsed = core.automationGraphSchema.safeParse(row.draft);
    const graph = parsed.success ? parsed.data : core.emptyGraph();
    const draft = canEdit ? graph : core.withoutPins(graph);
    const hooks: Record<string, string> = {};
    if (canEdit)
        for (const node of draft.nodes)
            if (node.type === "core.webhook") {
                const config = core.CORE_NODE_CONFIGS["core.webhook"].safeParse(node.config);
                hooks[node.id] = hookPath(
                    row.id,
                    node.id,
                    config.success ? config.data.rotation : 0
                );
            }
    const lanAllowed = await mayAllowLocalNetwork(actor, row);
    const named = namedAutomations(draft).filter((other) => other !== row.id);
    const shelf = row.orgId ? { orgId: row.orgId } : { orgId: null, userId: row.userId };
    // Somebody it was shared with sees the names its own steps use, not the shelf's list.
    const onShelf = await mayReadShelf(actor, row);
    const [live, lastTest, listed, kept] = await Promise.all([
        row.publishedVersionId
            ? prisma.automationVersion.findUnique({
                  where: { id: row.publishedVersionId },
                  select: { id: true, number: true, graph: true }
              })
            : null,
        canEdit
            ? prisma.automationRun.findFirst({
                  where: { automationId: row.id, test: true },
                  orderBy: { queuedAt: "desc" },
                  select: { id: true }
              })
            : null,
        prisma.automation.findMany({
            where: onShelf ? { ...shelf, id: { not: row.id } } : { id: { in: [] } },
            orderBy: { name: "asc" },
            take: OTHERS_LISTED,
            select: { id: true, name: true }
        }),
        named.length
            ? prisma.automation.findMany({
                  where: { ...shelf, id: { in: named } },
                  select: { id: true, name: true }
              })
            : []
    ]);
    const others = [
        ...listed,
        ...kept.filter((one) => !listed.some((other) => other.id === one.id))
    ].sort((a, b) => a.name.localeCompare(b.name));
    const liveGraph = live ? core.automationGraphSchema.safeParse(live.graph) : null;
    return {
        id: row.id,
        name: row.name,
        description: row.description,
        enabled: row.enabled,
        published: row.publishedVersionId !== null,
        mode: (core.AUTOMATION_MODES as readonly string[]).includes(row.mode)
            ? (row.mode as core.AutomationMode)
            : "single",
        maxRuns: row.maxRuns,
        rateLimit: row.rateLimit,
        allowLocalNetwork: row.allowLocalNetwork,
        canEdit,
        localNetworkRefusal: lanAllowed ? null : row.orgId ? "orgAdminOnly" : "instanceAdminOnly",
        draft,
        hooks,
        isOrg: row.orgId !== null,
        origin: row.origin ?? null,
        originRef: row.originRef ?? null,
        publishedVersion:
            live && liveGraph?.success
                ? { id: live.id, number: live.number, graph: liveGraph.data }
                : null,
        lastTestRunId: lastTest?.id ?? null,
        others
    };
}

/** The other automations a graph's Run another automation and An automation failed steps name. */
function namedAutomations(graph: core.AutomationGraph): string[] {
    const ids = new Set<string>();
    for (const node of graph.nodes) {
        const config = (node.config ?? {}) as { automationId?: unknown; automations?: unknown };
        if (node.type === "core.run" && typeof config.automationId === "string")
            ids.add(config.automationId);
        if (node.type === "core.failed" && Array.isArray(config.automations))
            for (const id of config.automations) if (typeof id === "string") ids.add(id);
    }
    return [...ids].filter(isUuid);
}

export async function shelfOf(id: string): Promise<Shelf> {
    const row = await prisma.automation.findUnique({
        where: { id },
        select: { orgId: true, userId: true }
    });
    if (!row) throw new AutomationAccessError("notFound");
    return row;
}

export async function createAutomation(
    actor: RunActor,
    input: {
        name: string;
        description: string;
        orgId: string | null;
        template?: core.AutomationTemplate;
    },
    timeZone: string,
    templateWords?: { title: string; body: string }
): Promise<string> {
    const shelf: Shelf = { orgId: input.orgId, userId: input.orgId ? null : actor.id };
    if (!(await mayEditShelf(actor, shelf))) throw new AutomationAccessError("forbidden");
    if ((await prisma.automation.count({ where: shelfWhere(shelf) })) >= L.perShelf)
        throw new AutomationAccessError("limit");
    const graph =
        input.template && templateWords
            ? core.internetBackGraph(timeZone, templateWords)
            : core.emptyGraph(timeZone);
    if (graph.nodes.length === 0)
        graph.nodes.push({
            id: core.automationNodeId(),
            type: "core.manual",
            typeVersion: 1,
            config: {}
        });
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

/**
 * The address a webhook trigger answers on, for one the editor holds that is
 * not saved yet or was given a new address since: the screen shows it from the
 * moment the trigger is added rather than after a save. Derived as on publish;
 * it starts working once a version with that node and rotation is published.
 */
export async function hookAddress(
    actor: RunActor,
    automationId: string,
    nodeId: string,
    rotation: number
): Promise<string> {
    const row = await load(actor, automationId, true);
    return hookPath(row.id, nodeId, rotation);
}

/** Secrets the graph names must be the automation's own shelf's. */
export async function checkSecrets(shelf: Shelf, graph: core.AutomationGraph): Promise<void> {
    const ids = new Set<string>();
    const collect = (value: unknown, key?: string) => {
        if (typeof value === "string" && (key === "secretId" || key === "urlSecretId"))
            ids.add(value);
        else if (value && typeof value === "object")
            for (const [k, v] of Object.entries(value)) collect(v, k);
    };
    for (const node of graph.nodes) collect(node.config);
    if (ids.size === 0) return;
    const found = await prisma.automationSecret.count({
        where: { id: { in: [...ids] }, ...shelfWhere(shelf) }
    });
    if (found !== ids.size) throw new AutomationAccessError("secretMissing");
}

export async function saveDraft(
    actor: RunActor,
    id: string,
    graph: core.AutomationGraph
): Promise<core.GraphProblem[]> {
    const row = await load(actor, id, true);
    const problems = await graphProblems(graph);
    if (problems.some((problem) => problem.code !== "badConfig")) return problems;
    await checkSecrets(row, graph);
    await checkChatWebhooks(actor, graph, row.draft);
    await checkNoticeTargets(actor, graph, row.draft);
    await prisma.automation.update({
        where: { id },
        data: { draft: graph as object, draftUpdatedAt: new Date() }
    });
    return problems;
}

/** Make the draft live: a new immutable version, armed, running as whoever published it. */
export async function publishAutomation(actor: RunActor, id: string): Promise<core.GraphProblem[]> {
    const row = await load(actor, id, true);
    const parsed = core.automationGraphSchema.safeParse(row.draft);
    if (!parsed.success) throw new AutomationAccessError("invalid");
    const problems = await graphProblems(parsed.data, { forPublish: true });
    if (problems.length > 0) return problems;
    const cycle = await callCycle(id, parsed.data, async (target) => {
        const other = await prisma.automation.findUnique({
            where: { id: target },
            select: { publishedVersionId: true }
        });
        return other?.publishedVersionId ? loadGraph(other.publishedVersionId) : null;
    });
    if (cycle) return [{ code: "callCycle", node: cycle.node }];
    await checkSecrets(row, parsed.data);
    await checkChatWebhooks(actor, parsed.data);
    await checkNoticeTargets(actor, parsed.data);
    const last = await prisma.automationVersion.findFirst({
        where: { automationId: id },
        orderBy: { number: "desc" },
        select: { number: true }
    });
    const version = await prisma.automationVersion.create({
        // Pinned samples belong to test runs of the draft, never to a live version.
        data: {
            automationId: id,
            number: Math.max(0, last?.number ?? 0) + 1,
            graph: core.withoutPins(parsed.data) as object,
            savedById: actor.id
        },
        select: { id: true }
    });
    await prisma.automation.update({
        where: { id },
        data: { publishedVersionId: version.id, runAsId: actor.id, enabled: true }
    });
    await armVersion(id, version.id, core.withoutPins(parsed.data));
    return [];
}

export async function setEnabled(actor: RunActor, id: string, enabled: boolean): Promise<void> {
    const row = await load(actor, id, true);
    if (enabled && !row.publishedVersionId) throw new AutomationAccessError("notPublished");
    await prisma.automation.update({ where: { id }, data: { enabled } });
    if (!enabled) return disarm(id);
    const version = await prisma.automationVersion.findUnique({
        where: { id: row.publishedVersionId! },
        select: { graph: true }
    });
    const graph = core.automationGraphSchema.safeParse(version?.graph);
    if (graph.success) await armVersion(id, row.publishedVersionId!, graph.data);
}

export async function updateSettings(
    actor: RunActor,
    id: string,
    settings: {
        name: string;
        description: string;
        mode: core.AutomationMode;
        maxRuns: number;
        rateLimit: number;
    }
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

/**
 * A Watch alarm carried into this automation goes back to Watch switched off,
 * so it neither points at nothing nor starts announcing again unasked.
 */
export async function deleteAutomation(actor: RunActor, id: string): Promise<void> {
    await load(actor, id, true);
    await prisma.$transaction([
        prisma.alarm.updateMany({
            where: { carriedToId: id },
            data: { carriedToId: null, enabled: false }
        }),
        prisma.automation.delete({ where: { id } })
    ]);
    // Nobody keeps looking at an automation that no longer exists.
    await dropGrantsFor("automation.automation", id);
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

export async function cancelRunFor(actor: RunActor, runId: string): Promise<void> {
    const run = await prisma.automationRun.findUnique({
        where: { id: runId },
        select: { automationId: true }
    });
    if (!run) throw new AutomationAccessError("notFound");
    await load(actor, run.automationId, true);
    await cancelRun(runId, "cancelledByPerson");
}
