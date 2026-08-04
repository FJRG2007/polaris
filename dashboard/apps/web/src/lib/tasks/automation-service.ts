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
 * Whether unfinished work this task depends on is still in its way.
 *
 * The one part of blocked-ness that is a question about other rows, so it is a
 * query rather than a field, exactly as the screens ask it. A rule reading
 * "Blocked is Yes" has to mean here what the same condition means in a saved
 * view, and three quarters of the answer is not a condition anybody would trust.
 */
async function dependsOnUnfinished(taskId: string): Promise<boolean> {
    const edges = await prisma.taskDependency.findMany({
        where: { blockedId: taskId, type: "blocks" },
        select: { blocker: { select: { status: { select: { type: true } } } } }
    });
    return edges.some((edge) => core.blockerHolds(edge.blocker.status?.type as core.TaskStatusType | undefined));
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
    const record = await prisma.task.findUnique({ where: { id: event.taskId }, select: FACT_SELECT });
    if (!record) return;

    const stored = await prisma.taskAutomation.findMany({
        where: { spaceId: record.spaceId, trigger: event.trigger, enabled: true },
        orderBy: { createdAt: "asc" }
    });
    if (stored.length === 0) return;

    // Only once there is a rule to match against: the dependency lookup is a
    // query, and a space with no rules for this trigger has already returned.
    const now = new Date();
    const facts = toFacts(
        record,
        core.taskIsBlocked(
            {
                statusType: (record.status?.type as core.TaskStatusType) ?? "open",
                dependsOnUnfinished: await dependsOnUnfinished(record.id),
                blockedUntil: record.blockedUntil,
                blockedNote: record.blockedNote
            },
            now
        )
    );
    const selected = core.selectAutomations(
        stored.map((rule) => ({
            id: rule.id,
            trigger: rule.trigger as core.AutomationTrigger,
            conditions: core.parseTaskFilter(rule.conditions),
            enabled: rule.enabled,
            listId: rule.listId
        })),
        { trigger: event.trigger, task: facts },
        now
    );

    for (const rule of selected) {
        const definition = stored.find((entry) => entry.id === rule.id);
        if (!definition) continue;
        try {
            for (const action of parseActions(definition.actions)) {
                await applyAction(record, action, event.actorId);
            }
            await prisma.taskAutomation.update({
                where: { id: rule.id },
                data: { runCount: { increment: 1 }, lastRunAt: new Date() }
            });
            await prisma.taskActivity.create({
                data: { taskId: event.taskId, userId: null, action: "automation", toValue: definition.name }
            });
        } catch (caught) {
            console.error(`polaris: automation "${definition.name}" failed:`, caught);
        }
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
