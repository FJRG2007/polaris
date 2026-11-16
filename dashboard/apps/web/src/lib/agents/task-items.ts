/**
 * Tasks items that follow agent sessions.
 *
 * A link ties one Tasks item to the session working on it: directly for a task
 * handed to an agent, or through the orchestration task for a run's worker. The
 * sweep reads every open link, derives each session's status with the one
 * function every screen uses (`deriveSessionStatus`), and moves the item to the
 * matching kind of status in its own space - unless a person has moved it since
 * the link last did, which holds the link for good (`task-item-status.ts`).
 *
 * Every write is made as the person the link belongs to, after their Tasks
 * access is asked again: a link is not a standing grant, and somebody who lost
 * their place in a space stops moving its cards the moment they lose it.
 * Everything here is best effort and quiet towards its caller - a session or a
 * run that started is not a failure because its card did not move.
 */

import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as access from "@/lib/tasks/access";
import * as tasks from "@/lib/tasks/task-service";
import { publishTaskChange } from "@/lib/tasks/live";
import * as derive from "@/lib/agents/session-status";
import * as facts from "@/lib/agents/session-pr-facts";
import * as rules from "@/lib/agents/task-item-status";

/** The role a link needs to write an item: the one editing a task asks. */
const WRITER: core.SpaceRole = "member";

/** Links read per sweep. Least recently read first, so none is starved. */
const SWEEP_CAP = 200;

/** A link older than this whose session never settled stops being read. */
const LINK_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

function actorOf(ownerId: string): access.TaskActor {
    return { id: ownerId, isAdmin: false };
}

/** Whether this person may change the item, quietly. */
async function mayWrite(ownerId: string, itemId: string): Promise<boolean> {
    try {
        await access.requireTask(actorOf(ownerId), itemId, WRITER);
        return true;
    } catch {
        return false;
    }
}

export interface LinkInput {
    readonly ownerId: string;
    readonly itemId: string;
    readonly sessionId?: string | null;
    readonly runId?: string | null;
    readonly orchestrationTaskId?: string | null;
}

/**
 * Link an item. Refused (false) when the person may not change it: following a
 * session is a write to the item, so it is checked as one.
 */
export async function linkItem(input: LinkInput): Promise<boolean> {
    if (!(await mayWrite(input.ownerId, input.itemId))) return false;
    const item = await prisma.task.findUnique({ where: { id: input.itemId }, select: { statusId: true } });
    if (!item) return false;
    const data = {
        itemId: input.itemId,
        ownerId: input.ownerId,
        sessionId: input.sessionId ?? null,
        runId: input.runId ?? null,
        orchestrationTaskId: input.orchestrationTaskId ?? null,
        appliedStatusId: item.statusId
    };
    if (data.orchestrationTaskId) {
        await prisma.taskAgentLink.upsert({
            where: { orchestrationTaskId: data.orchestrationTaskId },
            create: data,
            update: {}
        });
    } else {
        await prisma.taskAgentLink.create({ data });
    }
    return true;
}

/** One orchestration task just added to a run, as the item hook reads it. */
export interface RunTaskForItem {
    readonly id: string;
    readonly title: string;
    readonly spec: string;
    /** The plan item it was spawned for, when it names one. */
    readonly itemId: string | null;
}

/**
 * Give a run's new tasks their items. A task that names one of the run's own
 * plan items takes that item; any other id is ignored, so a coordinator can
 * never reach an item the person did not hand it. The rest become new items in
 * the run's list, when the run has one and its person may still write there.
 */
export async function writeRunItems(
    run: { id: string; ownerId: string; taskListId: string | null },
    created: readonly RunTaskForItem[]
): Promise<void> {
    let list: { listId: string; spaceId: string } | null | undefined;
    for (const task of created) {
        try {
            if (await prisma.taskAgentLink.count({ where: { orchestrationTaskId: task.id } })) continue;
            if (task.itemId) {
                const claimed = await prisma.taskAgentLink.updateMany({
                    where: { runId: run.id, itemId: task.itemId, orchestrationTaskId: null, settled: false },
                    data: { orchestrationTaskId: task.id }
                });
                if (claimed.count > 0) continue;
            }
            if (!run.taskListId) continue;
            if (list === undefined) {
                list = await access
                    .requireList(actorOf(run.ownerId), run.taskListId, WRITER)
                    .then(({ listId, spaceId }) => ({ listId, spaceId }))
                    .catch(() => null);
            }
            if (!list) return;
            const input = core.taskCreateSchema.safeParse({
                listId: list.listId,
                name: task.title,
                description: task.spec.slice(0, core.TASK_DESCRIPTION_MAX)
            });
            if (!input.success) continue;
            const item = await tasks.createTask(run.ownerId, list.spaceId, input.data);
            await linkItem({ ownerId: run.ownerId, itemId: item.id, runId: run.id, orchestrationTaskId: task.id });
            publishTaskChange({ spaceId: list.spaceId, actorId: run.ownerId });
        } catch (error) {
            console.error("[task-items] could not write a run's item", error);
        }
    }
}

const linkSelect = {
    id: true,
    itemId: true,
    ownerId: true,
    sessionId: true,
    runId: true,
    orchestrationTaskId: true,
    appliedStatusId: true,
    held: true,
    createdAt: true
} as const;

/**
 * Move every open link's item on. Bounded and resumable: the links read least
 * recently go first and every link read is touched, so a sweep that stops
 * halfway picks up where it left off. Answers how many links it read.
 */
export async function syncTaskItems(now = new Date()): Promise<number> {
    const links = await prisma.taskAgentLink.findMany({
        where: { settled: false, held: false },
        select: linkSelect,
        orderBy: { updatedAt: "asc" },
        take: SWEEP_CAP
    });
    if (links.length === 0) return 0;

    const taskIds = links.flatMap((link) => (link.orchestrationTaskId ? [link.orchestrationTaskId] : []));
    const runIds = [...new Set(links.flatMap((link) => (link.runId ? [link.runId] : [])))];
    const [orchestrated, runs] = await Promise.all([
        taskIds.length
            ? prisma.agentOrchestrationTask.findMany({
                  where: { id: { in: taskIds } },
                  select: { id: true, sessionId: true }
              })
            : Promise.resolve([]),
        runIds.length
            ? prisma.agentOrchestrationRun.findMany({ where: { id: { in: runIds } }, select: { id: true, status: true } })
            : Promise.resolve([])
    ]);
    const sessionOfTask = new Map(orchestrated.map((row) => [row.id, row.sessionId]));
    const runStatus = new Map(runs.map((row) => [row.id, row.status]));
    const sessionOf = (link: (typeof links)[number]) =>
        link.sessionId ?? (link.orchestrationTaskId ? (sessionOfTask.get(link.orchestrationTaskId) ?? null) : null);

    const sessionIds = [...new Set(links.flatMap((link) => sessionOf(link) ?? []))];
    const itemIds = [...new Set(links.map((link) => link.itemId))];
    const [sessionRows, pulls, items] = await Promise.all([
        sessionIds.length
            ? prisma.agentSession.findMany({
                  where: { id: { in: sessionIds } },
                  select: { id: true, state: true, lastEventAt: true, startedAt: true, createdAt: true }
              })
            : Promise.resolve([]),
        facts.readSessionPullRows(sessionIds),
        prisma.task.findMany({ where: { id: { in: itemIds } }, select: { id: true, statusId: true, spaceId: true } })
    ]);
    const spaceIds = [...new Set(items.map((item) => item.spaceId))];
    const statuses = spaceIds.length
        ? await prisma.taskStatus.findMany({
              where: { spaceId: { in: spaceIds } },
              select: { id: true, spaceId: true, type: true, order: true }
          })
        : [];
    const sessionsById = new Map(sessionRows.map((row) => [row.id, row]));
    const itemsById = new Map(items.map((item) => [item.id, item]));

    const touched: string[] = [];
    for (const link of links) {
        const item = itemsById.get(link.itemId);
        // The item went: so does the link.
        if (!item) {
            await prisma.taskAgentLink.deleteMany({ where: { id: link.id } });
            continue;
        }
        const expired = now.getTime() - link.createdAt.getTime() > LINK_LIFETIME_MS;
        const runOver = link.runId ? runStatus.get(link.runId) !== "active" : false;
        const sessionId = sessionOf(link);
        const row = sessionId ? sessionsById.get(sessionId) : undefined;
        if (!row) {
            // No session yet: a plan item, or a worker waiting for a slot. It
            // never gets one once its run is over.
            if (expired || runOver || sessionId) await settle(link.id, null);
            else touched.push(link.id);
            continue;
        }
        const pullRows = pulls.get(row.id) ?? [];
        const status = derive.deriveSessionStatus(
            derive.sessionFactsFrom({
                state: row.state as core.AgentSessionState,
                lastEventAt: row.lastEventAt,
                startedAt: row.startedAt,
                createdAt: row.createdAt
            }),
            pullRows.map(facts.pullFactsOf),
            now
        );
        // Over when there is nothing left to happen: merged, or ended with no
        // pull request still open that could be.
        const over =
            expired ||
            status === "merged" ||
            (core.isSessionOver(row.state as core.AgentSessionState) &&
                !pullRows.some((pull) => pull.state === "open"));
        const target = rules.pickStatus(
            statuses.filter((entry) => entry.spaceId === item.spaceId),
            rules.statusTypeFor(status)
        );
        const decision = rules.decideLinkMove(link, item, target);
        if (decision.kind === "hold") {
            await hold(link.id);
            continue;
        }
        if (decision.kind === "keep") {
            if (over) await settle(link.id, status);
            else touched.push(link.id);
            continue;
        }
        await moveItem(link, item.spaceId, decision.statusId, status, over);
    }
    if (touched.length) {
        await prisma.taskAgentLink.updateMany({ where: { id: { in: touched } }, data: { updatedAt: now } });
    }
    return links.length;
}

async function settle(linkId: string, status: string | null): Promise<void> {
    await prisma.taskAgentLink.updateMany({
        where: { id: linkId },
        data: { settled: true, ...(status ? { lastStatus: status } : {}) }
    });
}

async function hold(linkId: string): Promise<void> {
    await prisma.taskAgentLink.updateMany({ where: { id: linkId }, data: { held: true } });
}

/** Write the item's new status, as the link's person, if it still may. */
async function moveItem(
    link: { id: string; itemId: string; ownerId: string; appliedStatusId: string | null },
    spaceId: string,
    statusId: string,
    status: string,
    over: boolean
): Promise<void> {
    if (!(await mayWrite(link.ownerId, link.itemId))) {
        // Out of reach now: it will not be in reach to write later either.
        await settle(link.id, null);
        return;
    }
    // Read again just before the write, so a person's move between the sweep's
    // read and now still wins.
    const fresh = await prisma.task.findUnique({ where: { id: link.itemId }, select: { statusId: true } });
    if (!fresh || fresh.statusId !== link.appliedStatusId) {
        await hold(link.id);
        return;
    }
    try {
        await tasks.updateTask(link.ownerId, core.taskUpdateSchema.parse({ taskId: link.itemId, statusId }));
    } catch (error) {
        // A space rule refused it (a blocker still open, say). Tried again on
        // the next sweep; the item keeps the status it had.
        console.error("[task-items] could not move an item", error);
        await prisma.taskAgentLink.updateMany({ where: { id: link.id }, data: { lastStatus: status } });
        return;
    }
    await prisma.taskAgentLink.updateMany({
        where: { id: link.id },
        data: { appliedStatusId: statusId, lastStatus: status, settled: over }
    });
    publishTaskChange({ spaceId, actorId: link.ownerId });
}

