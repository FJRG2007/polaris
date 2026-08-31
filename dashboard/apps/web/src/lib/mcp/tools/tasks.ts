/**
 * Tasks, as tools an agent can call.
 *
 * This is the half of the loop that makes "give this to Claude" mean something.
 * A session is started against a task; the agent reads it here, moves it to
 * whatever its space calls "in progress", does the work, and says what it found
 * in a comment. Nobody transcribes anything, and the board is right because the
 * thing doing the work is what updated it.
 *
 * Two decisions shape all of these:
 *
 *   - Everything goes through the same access layer the screens use. An API key
 *     is a different credential for the same account, never a wider one, so a
 *     space its owner cannot reach is a space its agent cannot reach either.
 *   - Statuses, spaces and lists are addressed by NAME as well as by id. An agent
 *     is handed a task and told to finish it; making it call a second tool to
 *     turn "In Progress" into a UUID is a round trip that exists only because the
 *     database has one, and it is the step a model gets wrong.
 */

import { z } from "zod";
import { prisma } from "@polaris/db";
import * as core from "@polaris/core";
import * as access from "@/lib/tasks/access";
import * as tasks from "@/lib/tasks/task-service";
import { addComment } from "@/lib/tasks/task-detail-service";
import type { TaskRow } from "@/lib/tasks/facts";
import { McpRefusal, type McpCaller, type McpTool, type McpToolResult } from "../protocol";

/** The actor shape the task layer authorises against, built from the key. */
async function actorFor(caller: McpCaller): Promise<access.TaskActor> {
    return { id: caller.userId, isAdmin: caller.isAdmin };
}

/** A task row, flattened to what a model needs to reason about it and nothing
 *  else. Ids are kept because the next tool call needs them; orders, colours and
 *  tracked seconds are dropped because no decision turns on them. */
function summarize(row: TaskRow): Record<string, unknown> {
    return {
        id: row.id,
        reference: row.reference,
        name: row.name,
        status: row.statusName,
        statusType: row.statusType,
        priority: row.priority,
        space: row.spaceName,
        list: row.listName,
        assignees: row.assignees.map((person) => person.name),
        dueDate: row.dueDate,
        subtasks: row.subtaskCount,
        comments: row.commentCount
    };
}

/** Both ways a task gets named. A reference is what a person quotes and what an
 *  agent is most likely to have been handed; an id is what a previous tool call
 *  returned. */
const taskRef = z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe('The task, as its reference ("ENG-42") or its id.');

/**
 * Resolve a reference or an id to a task the caller may at least read.
 *
 * Refuses rather than returning null, because every caller here would turn a null
 * into the same sentence and the sentence is better written once. What it says is
 * deliberately the same for "no such task" and "not yours": a key must not be
 * able to enumerate an instance's task numbers by watching which ones say
 * something different.
 */
async function resolveTask(caller: McpCaller, ref: string): Promise<{ id: string; spaceId: string }> {
    const scope = await access.visibleScope(await actorFor(caller));
    const reachable = access.scopeTaskWhere(scope);
    const trimmed = ref.trim();
    const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(trimmed);
    const task = match
        ? await prisma.task.findFirst({
              where: {
                  AND: [reachable, { number: Number(match[2]), space: { prefix: match[1]!.toUpperCase() } }]
              },
              select: { id: true, spaceId: true }
          })
        : await prisma.task.findFirst({
              where: { AND: [reachable, { id: trimmed }] },
              select: { id: true, spaceId: true }
          });
    if (!task) throw new McpRefusal(`No task called ${trimmed} that this key can reach.`);
    return task;
}

/** The status in a space whose name the caller meant. Compared case-insensitively
 *  and with the spacing ignored, because "in progress", "In Progress" and
 *  "InProgress" are one status that a model will spell three ways. */
async function resolveStatus(spaceId: string, name: string): Promise<{ id: string; name: string }> {
    const statuses = await prisma.taskStatus.findMany({
        where: { spaceId },
        select: { id: true, name: true },
        orderBy: { order: "asc" }
    });
    const flatten = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");
    const wanted = flatten(name);
    const found = statuses.find((status) => flatten(status.name) === wanted);
    if (found) return found;
    throw new McpRefusal(
        `That space has no status called "${name}". It has: ${statuses.map((status) => status.name).join(", ")}.`
    );
}

function text(body: string, structured?: unknown): McpToolResult {
    return structured === undefined ? { text: body } : { text: body, structured };
}

// ---------------------------------------------------------------------------
// The tools
// ---------------------------------------------------------------------------

const listInput = z.object({
    query: z.string().trim().max(200).default("").describe("Match against the name or the reference."),
    space: z.string().trim().max(80).default("").describe("Limit to one space, by name or id."),
    mine: z.boolean().default(false).describe("Only tasks assigned to the account this key belongs to."),
    openOnly: z.boolean().default(true).describe("Leave out anything whose status counts as finished."),
    limit: z.number().int().min(1).max(100).default(25)
});

const listTasksTool: McpTool<z.infer<typeof listInput>> = {
    name: "tasks_list",
    description:
        "Find tasks this key can reach. Returns a summary of each - reference, name, status, assignees - not the full description; use tasks_get for that.",
    input: listInput,
    scope: "tasks.read",
    readOnly: true,
    async run(input, caller) {
        const scope = await access.visibleScope(await actorFor(caller));
        const spaceIds = access.scopeSpaceIds(scope);
        let wanted = spaceIds;
        if (input.space) {
            const space = await prisma.taskSpace.findFirst({
                where: {
                    id: { in: spaceIds },
                    OR: [{ id: input.space }, { name: { equals: input.space, mode: "insensitive" } }]
                },
                select: { id: true }
            });
            if (!space) throw new McpRefusal(`No space called "${input.space}" that this key can reach.`);
            wanted = [space.id];
        }

        const rows = await tasks.listTasks(
            { spaceIds: wanted, listIds: scope.listIds, ...(input.mine ? { assigneeId: caller.userId } : {}) },
            { openOnly: input.openOnly, limit: 500 }
        );
        const needle = input.query.toLowerCase();
        const matched = (
            needle
                ? rows.filter(
                      (row) =>
                          row.name.toLowerCase().includes(needle) || row.reference.toLowerCase().includes(needle)
                  )
                : rows
        ).slice(0, input.limit);

        if (matched.length === 0) return text("Nothing matched.", { tasks: [] });
        const summaries = matched.map(summarize);
        return text(
            matched.map((row) => `${row.reference}  ${row.name}  [${row.statusName}]`).join("\n"),
            { tasks: summaries }
        );
    }
};

const getInput = z.object({ task: taskRef });

const getTaskTool: McpTool<z.infer<typeof getInput>> = {
    name: "tasks_get",
    description: "Read one task in full: its description, status, assignees, subtasks and comments.",
    input: getInput,
    scope: "tasks.read",
    readOnly: true,
    async run(input, caller) {
        const { id } = await resolveTask(caller, input.task);
        const detail = await tasks.getTaskDetail(id);
        if (!detail) throw new McpRefusal("That task no longer exists.");
        const body = [
            `${detail.task.reference}  ${detail.task.name}`,
            `Status: ${detail.task.statusName} (${detail.task.statusType})   Priority: ${detail.task.priority}`,
            `Space: ${detail.task.spaceName} / ${detail.task.listName}`,
            detail.task.assignees.length > 0
                ? `Assigned to: ${detail.task.assignees.map((person) => person.name).join(", ")}`
                : "Assigned to nobody",
            detail.task.dueDate ? `Due: ${detail.task.dueDate}` : "",
            "",
            detail.task.description || "(no description)",
            detail.comments.length > 0 ? `\nComments (${detail.comments.length}):` : "",
            ...detail.comments.map((comment) => `- ${comment.author?.name ?? "someone"}: ${comment.body}`)
        ]
            .filter((line) => line !== "")
            .join("\n");
        return text(body, {
            task: summarize(detail.task),
            description: detail.task.description,
            subtasks: detail.subtasks.map(summarize)
        });
    }
};

const createInput = z.object({
    list: z.string().trim().min(1).max(80).describe("The list to put it in, by name or id."),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(20_000).default(""),
    priority: z.enum(core.TASK_PRIORITIES).default("none"),
    assignToMe: z.boolean().default(false)
});

const createTaskTool: McpTool<z.infer<typeof createInput>> = {
    name: "tasks_create",
    description:
        "Create a task. Use this for work you found that is out of scope for what you were asked to do, rather than doing it unasked.",
    input: createInput,
    scope: "tasks.manage",
    readOnly: false,
    async run(input, caller) {
        const actor = await actorFor(caller);
        const scope = await access.visibleScope(actor);
        const spaceIds = access.scopeSpaceIds(scope);
        const list = await prisma.taskList.findFirst({
            where: {
                archived: false,
                spaceId: { in: spaceIds },
                OR: [{ id: input.list }, { name: { equals: input.list, mode: "insensitive" } }]
            },
            select: { id: true, spaceId: true }
        });
        if (!list) throw new McpRefusal(`No list called "${input.list}" that this key can reach.`);
        // Same rule as the screen: reaching a list is not permission to add to it.
        await access.requireList(actor, list.id, "member");

        const created = await tasks.createTask(caller.userId, list.spaceId, {
            ...core.taskCreateSchema.parse({
                listId: list.id,
                name: input.name,
                description: input.description,
                priority: input.priority,
                assigneeIds: input.assignToMe ? [caller.userId] : []
            })
        });
        return text(`Created ${created.reference}.`, { id: created.id, reference: created.reference });
    }
};

const updateInput = z.object({
    task: taskRef,
    status: z.string().trim().max(80).optional().describe('The status to move it to, by name ("In Progress").'),
    name: z.string().trim().min(1).max(200).optional(),
    description: z.string().max(20_000).optional(),
    priority: z.enum(core.TASK_PRIORITIES).optional(),
    assignToMe: z.boolean().optional().describe("Put the account this key belongs to on it.")
});

const updateTaskTool: McpTool<z.infer<typeof updateInput>> = {
    name: "tasks_update",
    description:
        "Change a task: move it to another status, rename it, set its priority, take it. Only the fields you send are written.",
    input: updateInput,
    scope: "tasks.manage",
    readOnly: false,
    async run(input, caller) {
        const actor = await actorFor(caller);
        const { id, spaceId } = await resolveTask(caller, input.task);
        await access.requireTask(actor, id, "member");

        const statusId = input.status ? (await resolveStatus(spaceId, input.status)).id : undefined;
        const assignees = input.assignToMe
            ? (await prisma.taskAssignee.findMany({ where: { taskId: id }, select: { userId: true } })).map(
                  (row) => row.userId
              )
            : undefined;
        if (assignees && !assignees.includes(caller.userId)) assignees.push(caller.userId);

        await tasks.updateTask(caller.userId, {
            taskId: id,
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.priority === undefined ? {} : { priority: input.priority }),
            ...(statusId === undefined ? {} : { statusId }),
            ...(assignees === undefined ? {} : { assigneeIds: assignees })
        });
        return text("Updated.");
    }
};

const commentInput = z.object({
    task: taskRef,
    body: z.string().trim().min(1).max(core.COMMENT_BODY_MAX)
});

const commentTaskTool: McpTool<z.infer<typeof commentInput>> = {
    name: "tasks_comment",
    description:
        "Leave a comment on a task. This is where what you found, what you changed and what you could not do belong - not in the task description.",
    input: commentInput,
    scope: "tasks.manage",
    readOnly: false,
    async run(input, caller) {
        const actor = await actorFor(caller);
        const { id } = await resolveTask(caller, input.task);
        await access.requireTask(actor, id, "guest");
        await addComment(caller.userId, { taskId: id, body: input.body, parentId: null, assignedToId: null });
        return text("Posted.");
    }
};

const spacesInput = z.object({});

const listSpacesTool: McpTool<z.infer<typeof spacesInput>> = {
    name: "tasks_spaces",
    description:
        "The spaces, lists and statuses this key can reach. Call this once if you need to know what a status or a list is called before using it.",
    input: spacesInput,
    scope: "tasks.read",
    readOnly: true,
    async run(_input, caller) {
        const scope = await access.visibleScope(await actorFor(caller));
        const spaceIds = access.scopeSpaceIds(scope);
        const spaces = await prisma.taskSpace.findMany({
            where: { id: { in: spaceIds }, archived: false },
            select: {
                id: true,
                name: true,
                prefix: true,
                statuses: { select: { name: true, type: true }, orderBy: { order: "asc" } },
                lists: {
                    where: { archived: false },
                    select: { id: true, name: true, folder: { select: { name: true } } },
                    orderBy: { order: "asc" }
                }
            },
            orderBy: { order: "asc" }
        });
        const lines = spaces.map((space) => {
            const lists = space.lists.map((list) =>
                list.folder ? `${list.folder.name} / ${list.name}` : list.name
            );
            return [
                `${space.name} (${space.prefix})`,
                `  statuses: ${space.statuses.map((status) => status.name).join(", ") || "none"}`,
                `  lists: ${lists.join(", ") || "none"}`
            ].join("\n");
        });
        return text(lines.join("\n\n") || "This key reaches no spaces.", { spaces });
    }
};

export const TASK_TOOLS = [
    listSpacesTool,
    listTasksTool,
    getTaskTool,
    createTaskTool,
    updateTaskTool,
    commentTaskTool
] as unknown as McpTool<never>[];
