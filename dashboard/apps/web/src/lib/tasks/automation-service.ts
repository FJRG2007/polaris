/**
 * The rule engine: when this happens to a task that looks like this, do these
 * things.
 *
 * Matching is delegated to @polaris/core so a rule's conditions mean exactly
 * what the same conditions mean in a saved view. What lives here is applying the
 * result, and one rule about that worth stating plainly: applying an action does
 * NOT raise a further event. A rule that sets a status would otherwise re-enter
 * the engine, and two rules pointing at each other would run until the request
 * timed out. One hop, always, and a rule that wants a chain says so by listing
 * both actions.
 *
 * The engine never throws into its caller either. A task change that succeeded
 * must not be rolled back because a rule referenced a status somebody deleted,
 * so a failing rule is logged and the rest still run.
 */

import * as core from "@polaris/core";
import { nextTaskNumber } from "./numbering";
import { prisma, type Prisma } from "@polaris/db";

export interface AutomationEventInput {
    readonly trigger: core.AutomationTrigger;
    readonly taskId: string;
    readonly actorId: string | null;
}

export interface AutomationBatchInput {
    readonly trigger: core.AutomationTrigger;
    readonly taskIds: readonly string[];
    readonly actorId: string | null;
}

/** The projection the engine needs to decide whether a rule applies. */
const FACT_SELECT = {
    id: true,
    name: true,
    spaceId: true,
    listId: true,
    parentId: true,
    statusId: true,
    priority: true,
    startDate: true,
    dueDate: true,
    timed: true,
    points: true,
    timeEstimate: true,
    archived: true,
    order: true,
    blockedUntil: true,
    blockedNote: true,
    completedAt: true,
    createdById: true,
    createdAt: true,
    updatedAt: true,
    status: { select: { type: true } },
    assignees: { select: { userId: true } },
    watchers: { select: { userId: true } },
    tags: { select: { tagId: true } },
    fieldValues: { select: { fieldId: true, value: true } }
} as const;

type FactRecord = Prisma.TaskGetPayload<{ select: typeof FACT_SELECT }>;

/**
 * Which of these tasks have unfinished work still in their way.
 *
 * The one part of blocked-ness that is a question about other rows, so it is a
 * query rather than a field, exactly as the screens ask it. A rule reading
 * "Blocked is Yes" has to mean here what the same condition means in a saved
 * view, and three quarters of the answer is not a condition anybody would trust.
 *
 * Asked for the whole batch at once, and only when a rule actually reads the
 * field: it is the one lookup here that no rule may ever need.
 */
async function blockedByDependency(taskIds: readonly string[]): Promise<Set<string>> {
    const edges = await prisma.taskDependency.findMany({
        where: { blockedId: { in: [...taskIds] }, type: "blocks" },
        select: { blockedId: true, blocker: { select: { status: { select: { type: true } } } } }
    });
    const held = new Set<string>();
    for (const edge of edges) {
        if (core.blockerHolds(edge.blocker.status?.type as core.TaskStatusType | undefined)) {
            held.add(edge.blockedId);
        }
    }
    return held;
}

function toFacts(record: FactRecord, blocked: boolean): core.TaskFacts {
    return {
        id: record.id,
        name: record.name,
        listId: record.listId,
        parentId: record.parentId,
        statusId: record.statusId,
        statusType: (record.status?.type as core.TaskStatusType) ?? "open",
        priority: record.priority as core.TaskPriority,
        assigneeIds: record.assignees.map((entry) => entry.userId),
        watcherIds: record.watchers.map((entry) => entry.userId),
        tagIds: record.tags.map((entry) => entry.tagId),
        createdById: record.createdById,
        startDate: record.startDate,
        dueDate: record.dueDate,
        timed: record.timed,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        completedAt: record.completedAt,
        points: record.points,
        timeEstimate: record.timeEstimate,
        archived: record.archived,
        order: record.order,
        blocked,
        customValues: Object.fromEntries(record.fieldValues.map((value) => [value.fieldId, value.value]))
    };
}

function parseActions(raw: string): core.AutomationAction[] {
    try {
        const parsed = core.automationActionSchema.array().safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : [];
    } catch {
        return [];
    }
}

/**
 * Whether any enabled rule in these spaces listens for any of these triggers.
 *
 * A write that touches one task simply calls `runAutomations` and lets it return
 * early. A write that touches a selection asks this first, so a space with no
 * rules at all costs one query rather than two per task.
 */
export async function hasAutomationsFor(
    spaceIds: readonly string[],
    triggers: readonly core.AutomationTrigger[]
): Promise<boolean> {
    if (spaceIds.length === 0 || triggers.length === 0) return false;
    const found = await prisma.taskAutomation.findFirst({
        where: { spaceId: { in: [...spaceIds] }, trigger: { in: [...triggers] }, enabled: true },
        select: { id: true }
    });
    return found !== null;
}

/**
 * Run every rule that applies to what just happened. Safe to call after any task
 * write; it is a no-op when the space has no rules for that trigger.
 */
export async function runAutomations(event: AutomationEventInput): Promise<void> {
    await runAutomationsFor({ trigger: event.trigger, taskIds: [event.taskId], actorId: event.actorId });
}

/**
 * The same thing for a selection: one event that happened to many tasks.
 *
 * Everything a rule needs that is not per-task is read once for the batch - the
 * rows, the rules in every space they span, and the dependency lookup - because
 * a write that touched five hundred tasks would otherwise re-ask all three five
 * hundred times per trigger. What stays per task is applying the actions, which
 * are writes to that task and have nowhere else to go.
 */
export async function runAutomationsFor(event: AutomationBatchInput): Promise<void> {
    const taskIds = [...new Set(event.taskIds)];
    if (taskIds.length === 0) return;

    const records = await prisma.task.findMany({ where: { id: { in: taskIds } }, select: FACT_SELECT });
    if (records.length === 0) return;

    const stored = await prisma.taskAutomation.findMany({
        where: {
            spaceId: { in: [...new Set(records.map((record) => record.spaceId))] },
            trigger: event.trigger,
            enabled: true
        },
        orderBy: { createdAt: "asc" }
    });
    if (stored.length === 0) return;

    // Parsed once per rule rather than once per task it is matched against, and
    // grouped by space because that is how each row picks the rules it answers to.
    const rules = stored.map((rule) => ({
        id: rule.id,
        spaceId: rule.spaceId,
        name: rule.name,
        trigger: rule.trigger as core.AutomationTrigger,
        conditions: core.parseTaskFilter(rule.conditions),
        enabled: rule.enabled,
        listId: rule.listId,
        actions: parseActions(rule.actions)
    }));
    const perSpace = new Map<string, typeof rules>();
    for (const rule of rules) {
        const held = perSpace.get(rule.spaceId);
        if (held) held.push(rule);
        else perSpace.set(rule.spaceId, [rule]);
    }

    const involved = records.filter((record) => perSpace.has(record.spaceId));
    if (involved.length === 0) return;

    // A rule that never asks whether a task is held up does not pay for the
    // answer. When none of them asks, the flag is left false rather than guessed:
    // nothing reads it, so a wrong value cannot reach a decision.
    const readsBlocked = rules.some((rule) => rule.conditions.conditions.some((one) => one.field === "blocked"));
    const heldUp = readsBlocked ? await blockedByDependency(involved.map((record) => record.id)) : new Set<string>();

    const now = new Date();
    // Counted rather than incremented per run: a rule that fired on forty rows is
    // forty runs and one write.
    const runs = new Map<string, number>();
    const lines: Prisma.TaskActivityCreateManyInput[] = [];

    for (const record of involved) {
        const facts = toFacts(
            record,
            core.taskIsBlocked(
                {
                    statusType: (record.status?.type as core.TaskStatusType) ?? "open",
                    dependsOnUnfinished: heldUp.has(record.id),
                    blockedUntil: record.blockedUntil,
                    blockedNote: record.blockedNote
                },
                now
            )
        );
        const scoped = perSpace.get(record.spaceId) ?? [];
        const selected = core.selectAutomations(scoped, { trigger: event.trigger, task: facts }, now);

        for (const rule of selected) {
            const definition = scoped.find((entry) => entry.id === rule.id);
            if (!definition) continue;
            try {
                for (const action of definition.actions) {
                    await applyAction(record, action, event.actorId);
                }
                runs.set(rule.id, (runs.get(rule.id) ?? 0) + 1);
                lines.push({ taskId: record.id, userId: null, action: "automation", toValue: definition.name });
            } catch (caught) {
                console.error(`polaris: automation "${definition.name}" failed:`, caught);
            }
        }
    }

    if (lines.length > 0) await prisma.taskActivity.createMany({ data: lines });
    const ranAt = new Date();
    for (const [ruleId, count] of runs) {
        await prisma.taskAutomation.update({
            where: { id: ruleId },
            data: { runCount: { increment: count }, lastRunAt: ranAt }
        });
    }
}

/** One action, applied to one task. Unknown target ids are ignored rather than
 *  throwing: a rule pointing at a deleted status should stop working, not stop
 *  every other rule behind it. */
async function applyAction(
    record: FactRecord,
    action: core.AutomationAction,
    actorId: string | null
): Promise<void> {
    const taskId = record.id;
    switch (action.type) {
        case "setStatus": {
            if (!action.targetId) return;
            const status = await prisma.taskStatus.findFirst({
                where: { id: action.targetId, spaceId: record.spaceId },
                select: { type: true }
            });
            if (!status) return;
            await prisma.task.update({
                where: { id: taskId },
                data: {
                    statusId: action.targetId,
                    completedAt: core.isFinishedStatus(status.type as core.TaskStatusType) ? new Date() : null
                }
            });
            return;
        }
        case "setPriority": {
            const priority = action.targetId as core.TaskPriority;
            if (!core.TASK_PRIORITIES.includes(priority)) return;
            await prisma.task.update({ where: { id: taskId }, data: { priority } });
            return;
        }
        case "addAssignee": {
            if (!action.targetId) return;
            await prisma.taskAssignee
                .create({ data: { taskId, userId: action.targetId } })
                .catch(() => undefined);
            return;
        }
        case "removeAssignee": {
            if (!action.targetId) return;
            await prisma.taskAssignee.deleteMany({ where: { taskId, userId: action.targetId } });
            return;
        }
        case "addTag": {
            if (!action.targetId) return;
            await prisma.taskTagLink.create({ data: { taskId, tagId: action.targetId } }).catch(() => undefined);
            return;
        }
        case "removeTag": {
            if (!action.targetId) return;
            await prisma.taskTagLink.deleteMany({ where: { taskId, tagId: action.targetId } });
            return;
        }
        case "setDueDate": {
            const due = new Date();
            due.setDate(due.getDate() + (action.offsetDays ?? 0));
            await prisma.task.update({ where: { id: taskId }, data: { dueDate: due } });
            return;
        }
        case "moveToList": {
            if (!action.targetId) return;
            const list = await prisma.taskList.findFirst({
                where: { id: action.targetId, spaceId: record.spaceId },
                select: { id: true }
            });
            if (!list) return;
            await prisma.task.update({ where: { id: taskId }, data: { listId: list.id } });
            return;
        }
        case "addComment": {
            if (!action.text) return;
            await prisma.taskComment.create({ data: { taskId, userId: null, body: action.text } });
            return;
        }
        case "addWatcher": {
            if (!action.targetId) return;
            await prisma.taskWatcher
                .create({ data: { taskId, userId: action.targetId } })
                .catch(() => undefined);
            return;
        }
        case "archive": {
            await prisma.task.update({ where: { id: taskId }, data: { archived: true } });
            return;
        }
        case "createSubtask": {
            if (!action.text) return;
            await prisma.$transaction(async (tx) => {
                const { number } = await nextTaskNumber(tx, record.spaceId);
                const last = await tx.task.findFirst({
                    where: { listId: record.listId },
                    orderBy: { order: "desc" },
                    select: { order: true }
                });
                await tx.task.create({
                    data: {
                        spaceId: record.spaceId,
                        listId: record.listId,
                        parentId: taskId,
                        number,
                        name: action.text as string,
                        statusId: record.statusId,
                        order: (last?.order ?? 0) + core.ORDER_STEP,
                        createdById: actorId
                    }
                });
            });
            return;
        }
    }
}

// ---------------------------------------------------------------------------
// Managing the rules themselves
// ---------------------------------------------------------------------------

export interface AutomationView {
    readonly id: string;
    readonly name: string;
    readonly trigger: core.AutomationTrigger;
    readonly listId: string | null;
    readonly conditions: core.TaskFilter;
    readonly actions: core.AutomationAction[];
    readonly enabled: boolean;
    readonly runCount: number;
    readonly lastRunAt: string | null;
}

export async function listAutomations(spaceId: string): Promise<AutomationView[]> {
    const rules = await prisma.taskAutomation.findMany({ where: { spaceId }, orderBy: { createdAt: "asc" } });
    return rules.map((rule) => ({
        id: rule.id,
        name: rule.name,
        trigger: rule.trigger as core.AutomationTrigger,
        listId: rule.listId,
        conditions: core.parseTaskFilter(rule.conditions),
        actions: parseActions(rule.actions),
        enabled: rule.enabled,
        runCount: rule.runCount,
        lastRunAt: rule.lastRunAt?.toISOString() ?? null
    }));
}

export async function createAutomation(
    spaceId: string,
    actorId: string,
    input: core.AutomationInput
): Promise<void> {
    await prisma.taskAutomation.create({
        data: {
            spaceId,
            listId: input.listId,
            name: input.name,
            trigger: input.trigger,
            conditions: JSON.stringify(input.conditions),
            actions: JSON.stringify(input.actions),
            enabled: input.enabled,
            createdById: actorId
        }
    });
}

export async function updateAutomation(automationId: string, input: core.AutomationInput): Promise<void> {
    await prisma.taskAutomation.update({
        where: { id: automationId },
        data: {
            listId: input.listId,
            name: input.name,
            trigger: input.trigger,
            conditions: JSON.stringify(input.conditions),
            actions: JSON.stringify(input.actions),
            enabled: input.enabled
        }
    });
}

export async function setAutomationEnabled(automationId: string, enabled: boolean): Promise<void> {
    await prisma.taskAutomation.update({ where: { id: automationId }, data: { enabled } });
}

export async function deleteAutomation(automationId: string): Promise<void> {
    await prisma.taskAutomation.delete({ where: { id: automationId } });
}
