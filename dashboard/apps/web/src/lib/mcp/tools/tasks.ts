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
import { addComment, addReminder, deleteReminder } from "@/lib/tasks/task-detail-service";
import type { TaskRow } from "@/lib/tasks/facts";
import { McpRefusal, type McpCaller, type McpTool, type McpToolResult } from "../protocol";
import { defineMcpSearch, preferMatches } from "../search";

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

/** What the id column actually holds. A reference that is not one is a string
 *  Prisma refuses to compare rather than a row that does not exist. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** And what the number column holds. A reference quoting more than this is not a
 *  task, whatever else it might be. */
const INT_MAX = 2_147_483_647;

/** Both ways a task gets named. A reference is what a person quotes and what an
 *  agent is most likely to have been handed; an id is what a previous tool call
 *  returned. */
const taskRef = z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe('The task, as its reference ("ENG-42"), its id, or its exact name.');

/**
 * Resolve a reference or an id to a task the caller may at least read.
 *
 * Refuses rather than returning null, because every caller here would turn a null
 * into the same sentence and the sentence is better written once. What it says is
 * deliberately the same for "no such task" and "not yours": a key must not be
 * able to enumerate an instance's task numbers by watching which ones say
 * something different.
 */
async function resolveTask(
    caller: McpCaller,
    ref: string
): Promise<{ id: string; spaceId: string }> {
    const scope = await access.visibleScope(await actorFor(caller));
    const reachable = access.scopeTaskWhere(scope);
    const trimmed = ref.trim();
    const match = /^([A-Za-z][A-Za-z0-9]*)-(\d+)$/.exec(trimmed);
    // Neither branch reaches the database with something the column cannot hold.
    // A reference whose number is past what an Int holds, and an id that is not a
    // UUID, both make Prisma throw rather than answer - and a thrown query is
    // reported to the model as "Polaris has logged why", which is no help at all
    // to something that has simply quoted a title instead of a reference. This is
    // the mistake the sentence below exists for, so it has to be the answer.
    const number = match ? Number(match[2]) : 0;
    if (match && (!Number.isSafeInteger(number) || number > INT_MAX)) {
        throw new McpRefusal(`No task called ${trimmed} that this key can reach.`);
    }
    if (!match && !UUID.test(trimmed)) return taskByName(scope, trimmed);
    const task = match
        ? await prisma.task.findFirst({
              where: {
                  AND: [reachable, { number, space: { prefix: match[1]!.toUpperCase() } }]
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

/**
 * A task named the way a person names it ("the invoice task" is not this, but
 * "Send the October invoices" is). Only an exact name, case and accents aside,
 * is taken: two tasks of one name are named back with their references rather
 * than one being guessed at, and a near miss is offered, not acted on.
 */
async function taskByName(
    scope: Awaited<ReturnType<typeof access.visibleScope>>,
    name: string
): Promise<{ id: string; spaceId: string }> {
    const reachable = { AND: [access.scopeTaskWhere(scope), { archived: false }] };
    const exact = await prisma.task.findMany({
        where: { AND: [reachable, { name: { equals: name, mode: "insensitive" } }] },
        select: NAMED_TASK,
        orderBy: { updatedAt: "desc" },
        take: NAMES_SHARED
    });
    const rows =
        exact.length > 0
            ? exact
            : await prisma.task.findMany({
                  where: reachable,
                  select: NAMED_TASK,
                  orderBy: { updatedAt: "desc" },
                  take: NAMES_SCANNED
              });
    const pick = core.pickByName(rows, name, (row) => row.name);
    if (pick.kind === "one") return { id: pick.item.id, spaceId: pick.item.spaceId };
    throw new McpRefusal(
        core.missedNameText(
            pick,
            name,
            "task",
            (row) => `${row.space.prefix}-${row.number} ${row.name}`
        )
    );
}

/** What naming a task back needs, and no more. */
const NAMED_TASK = {
    id: true,
    spaceId: true,
    name: true,
    number: true,
    space: { select: { prefix: true } }
} as const;

/** How many tasks sharing one name a refusal names. */
const NAMES_SHARED = 10;

/** How many recently touched tasks a near miss is looked for among. */
const NAMES_SCANNED = 500;

/** An instant as the person reads it: "Thu 8 Oct, 09:00", in their zone. */
async function onTheirClock(userId: string, at: readonly Date[]): Promise<string[]> {
    const { resolveDisplayPreferencesFor } = await import("@/lib/display-prefs-service");
    const { timeZone } = await resolveDisplayPreferencesFor(userId);
    const format = new Intl.DateTimeFormat("en-GB", {
        timeZone,
        weekday: "short",
        day: "numeric",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23"
    });
    return at.map((instant) => format.format(instant));
}

/** A day or a wall time as a model writes one: what the person would say. */
const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:T([01]\d|2[0-3]):([0-5]\d))?$/;

/**
 * A day or a time the model wrote, as the instant it names on the person's own
 * clock - the zone their dates are shown in, not the server's. A day alone is
 * the start of it, which is how the date picker stores an all-day due date.
 */
async function wallInstant(userId: string, value: string): Promise<{ at: Date; timed: boolean }> {
    const parts = WALL.exec(value);
    if (!parts) throw new McpRefusal("Write YYYY-MM-DD, or YYYY-MM-DDTHH:mm.");
    const [year, month, day] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
    const check = new Date(Date.UTC(year, month - 1, day));
    if (check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day)
        throw new McpRefusal(`There is no day ${value.slice(0, 10)}.`);
    const timed = parts[4] !== undefined;
    // Loaded when a date is read: the preferences reach the session layer, which
    // the rest of the catalogue has no need of.
    const { resolveDisplayPreferencesFor } = await import("@/lib/display-prefs-service");
    const { timeZone } = await resolveDisplayPreferencesFor(userId);
    const at = core.zonedInstant(
        {
            year,
            month,
            day,
            hours: timed ? Number(parts[4]) : 0,
            minutes: timed ? Number(parts[5]) : 0
        },
        timeZone
    );
    return { at, timed };
}

/** A due date as `tasks_create` and `tasks_update` take it; empty clears it. */
async function dueOf(
    userId: string,
    value: string
): Promise<{ dueDate: string | null; timed: boolean }> {
    if (value === "") return { dueDate: null, timed: false };
    const { at, timed } = await wallInstant(userId, value);
    return { dueDate: at.toISOString(), timed };
}

const dueField = z
    .string()
    .trim()
    .max(16)
    .refine((value) => value === "" || WALL.test(value), "Write YYYY-MM-DD, or YYYY-MM-DDTHH:mm")
    .describe(
        `When it is due: "YYYY-MM-DD" for a day, "YYYY-MM-DDTHH:mm" for a time, on the person's own clock.`
    );

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
    query: z
        .string()
        .trim()
        .max(200)
        .default("")
        .describe(
            "Words for the task's name or its reference, in any language. The best matches come first; when nothing matches, the tasks this key reaches are listed."
        ),
    space: z.string().trim().max(80).default("").describe("Limit to one space, by name or id."),
    mine: z
        .boolean()
        .default(false)
        .describe("Only tasks assigned to the account this key belongs to."),
    openOnly: z
        .boolean()
        .default(true)
        .describe("Leave out anything whose status counts as finished."),
    limit: z.number().int().min(1).max(100).default(25)
});

/** Where a task search reads: its name, its reference, then where it is. */
const TASK_FIELDS: readonly core.SearchField<TaskRow>[] = [
    { text: (row) => row.name, weight: 1 },
    { text: (row) => row.reference, weight: 1 },
    { text: (row) => [row.listName, row.spaceName, row.statusName], weight: 0.4 }
];

/** How many spaces a refusal names before it stops. */
const SPACES_NAMED = 20;

/**
 * The space a name means once accents and case are set aside ("diseno" is
 * "Diseño"), or a refusal naming the spaces there are, so the model picks one
 * rather than stopping. Only reached when the exact lookup found nothing.
 */
async function spaceByFoldedName(
    spaceIds: readonly string[],
    name: string
): Promise<{ id: string }> {
    const spaces = await prisma.taskSpace.findMany({
        where: { id: { in: [...spaceIds] } },
        select: { id: true, name: true },
        orderBy: { name: "asc" },
        take: 200
    });
    const wanted = core.normalizeSearchText(name);
    const found = spaces.find((space) => core.normalizeSearchText(space.name) === wanted);
    if (found) return found;
    const names = spaces.slice(0, SPACES_NAMED).map((space) => space.name);
    throw new McpRefusal(
        names.length > 0
            ? `No space called "${name}" that this key can reach. It can reach: ${names.join(", ")}.`
            : `No space called "${name}" that this key can reach.`
    );
}

/**
 * The same for a list a task is created in. Two lists of one name in two
 * spaces are not guessed between: the refusal names both, with their spaces.
 */
async function listByFoldedName(
    spaceIds: readonly string[],
    name: string
): Promise<{ id: string; spaceId: string }> {
    const lists = await prisma.taskList.findMany({
        where: { archived: false, spaceId: { in: [...spaceIds] } },
        select: { id: true, name: true, spaceId: true, space: { select: { name: true } } },
        orderBy: { name: "asc" },
        take: 200
    });
    const wanted = core.normalizeSearchText(name);
    const found = lists.filter((list) => core.normalizeSearchText(list.name) === wanted);
    if (found.length === 1) return found[0]!;
    const named = (found.length > 1 ? found : lists)
        .slice(0, SPACES_NAMED)
        .map((list) => `${list.name} (${list.space.name})`);
    throw new McpRefusal(
        found.length > 1
            ? `More than one list is called "${name}": ${named.join(", ")}. Pass the list's id.`
            : named.length > 0
              ? `No list called "${name}" that this key can reach. It can reach: ${named.join(", ")}.`
              : `No list called "${name}" that this key can reach.`
    );
}

const listTasksTool: McpTool<z.infer<typeof listInput>> = {
    name: "tasks_list",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List tasks",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Find tasks this key can reach. Returns a summary of each - reference, name, status, assignees - not the full description; use tasks_get for that.",
    input: listInput,
    category: "productivity",
    scope: "tasks.read",
    readOnly: true,
    async run(input, caller) {
        const scope = await access.visibleScope(await actorFor(caller));
        const spaceIds = access.scopeSpaceIds(scope);
        let wanted = spaceIds;
        if (input.space) {
            const space =
                (await prisma.taskSpace.findFirst({
                    where: {
                        id: { in: spaceIds },
                        OR: [
                            { id: input.space },
                            { name: { equals: input.space, mode: "insensitive" } }
                        ]
                    },
                    select: { id: true }
                })) ?? (await spaceByFoldedName(spaceIds, input.space));
            wanted = [space.id];
        }

        const rows = await tasks.listTasks(
            {
                spaceIds: wanted,
                listIds: scope.listIds,
                ...(input.mine ? { assigneeId: caller.userId } : {})
            },
            { openOnly: input.openOnly, limit: 500 }
        );
        const found = core.matchForModel(
            rows,
            input.query,
            TASK_FIELDS,
            { one: "task", other: "tasks" },
            input.limit
        );

        if (found.items.length === 0) return text("Nothing matched.", { tasks: [] });
        const summaries = found.items.map(summarize);
        return text(
            (found.note ? `${found.note}\n` : "") +
                found.items
                    .map((row) => `${row.reference}  ${row.name}  [${row.statusName}]`)
                    .join("\n"),
            { tasks: summaries, matched: found.matched }
        );
    }
};

const getInput = z.object({ task: taskRef });

const getTaskTool: McpTool<z.infer<typeof getInput>> = {
    name: "tasks_get",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Read a task",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Read one task in full: its description, status, assignees, subtasks and comments.",
    input: getInput,
    category: "productivity",
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
            ...detail.comments.map(
                (comment) => `- ${comment.author?.name ?? "someone"}: ${comment.body}`
            )
        ]
            .filter((line) => line !== "")
            .join("\n");
        return text(body, {
            task: summarize(detail.task),
            // i18n-ignore read by the calling model, not shown to a person
            description: detail.task.description,
            subtasks: detail.subtasks.map(summarize)
        });
    }
};

const createInput = z.object({
    list: z.string().trim().min(1).max(80).describe("The list to put it in, by name or id."),
    name: z.string().trim().min(1).max(200),
    // i18n-ignore read by the calling model, not shown to a person
    description: z.string().max(20_000).default(""),
    priority: z.enum(core.TASK_PRIORITIES).default("none"),
    assignToMe: z.boolean().default(false),
    due: dueField.default("")
});

const createTaskTool: McpTool<z.infer<typeof createInput>> = {
    name: "tasks_create",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Create a task",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Create a task, with a due date if one is given. Use this for work you found that is out of scope for what you were asked to do, rather than doing it unasked.",
    input: createInput,
    category: "productivity",
    scope: "tasks.manage",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const actor = await actorFor(caller);
        const scope = await access.visibleScope(actor);
        const spaceIds = access.scopeSpaceIds(scope);
        const list =
            (await prisma.taskList.findFirst({
                where: {
                    archived: false,
                    spaceId: { in: spaceIds },
                    OR: [{ id: input.list }, { name: { equals: input.list, mode: "insensitive" } }]
                },
                select: { id: true, spaceId: true }
            })) ?? (await listByFoldedName(spaceIds, input.list));
        // Same rule as the screen: reaching a list is not permission to add to it.
        await access.requireList(actor, list.id, "member");

        const created = await tasks.createTask(caller.userId, list.spaceId, {
            ...core.taskCreateSchema.parse({
                listId: list.id,
                name: input.name,
                // i18n-ignore read by the calling model, not shown to a person
                description: input.description,
                priority: input.priority,
                assigneeIds: input.assignToMe ? [caller.userId] : [],
                ...(await dueOf(caller.userId, input.due))
            })
        });
        return text(`Created ${created.reference}.`, {
            id: created.id,
            reference: created.reference
        });
    }
};

const updateInput = z.object({
    task: taskRef,
    status: z
        .string()
        .trim()
        .max(80)
        .optional()
        .describe('The status to move it to, by name ("In Progress").'),
    name: z.string().trim().min(1).max(200).optional(),
    // i18n-ignore read by the calling model, not shown to a person
    description: z.string().max(20_000).optional(),
    priority: z.enum(core.TASK_PRIORITIES).optional(),
    assignToMe: z.boolean().optional().describe("Put the account this key belongs to on it."),
    due: dueField
        .optional()
        .describe(
            `A new due date: "YYYY-MM-DD", "YYYY-MM-DDTHH:mm" on the person's own clock, or "" to clear it.`
        )
});

const updateTaskTool: McpTool<z.infer<typeof updateInput>> = {
    name: "tasks_update",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Change a task",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Change a task: move it to another status, rename it, set its priority or due date, take it. Only the fields you send are written.",
    input: updateInput,
    category: "productivity",
    scope: "tasks.manage",
    readOnly: false,
    idempotent: true,
    async run(input, caller) {
        const actor = await actorFor(caller);
        const { id, spaceId } = await resolveTask(caller, input.task);
        await access.requireTask(actor, id, "member");

        const statusId = input.status ? (await resolveStatus(spaceId, input.status)).id : undefined;
        const assignees = input.assignToMe
            ? (
                  await prisma.taskAssignee.findMany({
                      where: { taskId: id },
                      select: { userId: true }
                  })
              ).map((row) => row.userId)
            : undefined;
        if (assignees && !assignees.includes(caller.userId)) assignees.push(caller.userId);

        await tasks.updateTask(caller.userId, {
            taskId: id,
            ...(input.name === undefined ? {} : { name: input.name }),
            // i18n-ignore read by the calling model, not shown to a person
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.priority === undefined ? {} : { priority: input.priority }),
            ...(statusId === undefined ? {} : { statusId }),
            ...(assignees === undefined ? {} : { assigneeIds: assignees }),
            ...(input.due === undefined ? {} : await dueOf(caller.userId, input.due))
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
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Comment on a task",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Leave a comment on a task. This is where what you found, what you changed and what you could not do belong - not in the task description.",
    input: commentInput,
    category: "productivity",
    scope: "tasks.manage",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const actor = await actorFor(caller);
        const { id } = await resolveTask(caller, input.task);
        await access.requireTask(actor, id, "guest");
        await addComment(caller.userId, {
            taskId: id,
            body: input.body,
            parentId: null,
            assignedToId: null
        });
        return text("Posted.");
    }
};

const spacesInput = z.object({});

const listSpacesTool: McpTool<z.infer<typeof spacesInput>> = {
    name: "tasks_spaces",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List task spaces",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The spaces, lists and statuses this key can reach. Call this once if you need to know what a status or a list is called before using it.",
    input: spacesInput,
    category: "productivity",
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

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

/** The most reminders one read lists: a person's pending ones are a handful. */
const REMINDERS_LISTED = 50;

const remindersInput = z.object({
    task: taskRef.optional().describe("Only the reminders on this task. Absent lists them all.")
});

const listRemindersTool: McpTool<z.infer<typeof remindersInput>> = {
    name: "tasks_reminders",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "List task reminders",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "The reminders this account has set on tasks and that have not gone off yet, soonest first, with their ids. Reminders are the person's own; nobody else sees them.",
    input: remindersInput,
    category: "productivity",
    scope: "tasks.read",
    readOnly: true,
    async run(input, caller) {
        const scope = await access.visibleScope(await actorFor(caller));
        const only = input.task ? (await resolveTask(caller, input.task)).id : undefined;
        const rows = await prisma.taskReminder.findMany({
            where: {
                userId: caller.userId,
                sentAt: null,
                ...(only ? { taskId: only } : {}),
                // A task the account no longer reaches is not named back to it.
                task: access.scopeTaskWhere(scope)
            },
            orderBy: { remindAt: "asc" },
            take: REMINDERS_LISTED,
            select: {
                id: true,
                remindAt: true,
                note: true,
                task: { select: { number: true, name: true, space: { select: { prefix: true } } } }
            }
        });
        const shown = await onTheirClock(
            caller.userId,
            rows.map((row) => row.remindAt)
        );
        const reminders = rows.map((row) => ({
            id: row.id,
            at: row.remindAt.toISOString(),
            note: row.note,
            task: `${row.task.space.prefix}-${row.task.number}`,
            taskName: row.task.name
        }));
        return text(
            reminders
                .map(
                    (row, index) =>
                        `${shown[index]}  ${row.task} ${row.taskName}${row.note ? ` - ${row.note}` : ""}  [${row.id}]`
                )
                .join("\n") || "No reminders pending.",
            { reminders }
        );
    }
};

const remindInput = z.object({
    task: taskRef,
    at: z
        .string()
        .trim()
        .min(1)
        .max(40)
        .describe(
            `When to remind: "YYYY-MM-DDTHH:mm" on the person's own clock, or an ISO time with its offset.`
        ),
    note: z
        .string()
        .trim()
        .max(200)
        .default("")
        .describe("What the reminder says. Empty says the task's name.")
});

/** An instant from a model: a wall time on the person's clock, or one with
 *  its own offset already, which is taken as written. */
async function instantOf(userId: string, value: string): Promise<Date> {
    if (WALL.test(value)) {
        const { at, timed } = await wallInstant(userId, value);
        if (!timed) throw new McpRefusal("Give a time as well as a day: YYYY-MM-DDTHH:mm.");
        return at;
    }
    const parsed = z.string().datetime({ offset: true }).safeParse(value);
    if (!parsed.success)
        throw new McpRefusal("Write the time as YYYY-MM-DDTHH:mm, or ISO with its offset.");
    return new Date(parsed.data);
}

const remindTool: McpTool<z.infer<typeof remindInput>> = {
    name: "tasks_remind",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Remind me about a task",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Set a reminder on a task for the account this key belongs to: at that time it gets a notification that opens the task. Only it is reminded.",
    input: remindInput,
    category: "productivity",
    // The screen lets a reader set one; a connection approved to read, though,
    // changes nothing - setting a reminder is a change like any other.
    scope: "tasks.manage",
    readOnly: false,
    destructive: false,
    async run(input, caller) {
        const actor = await actorFor(caller);
        const { id } = await resolveTask(caller, input.task);
        // The screen's rule: reading a task is enough to be reminded of it.
        await access.requireTask(actor, id, "guest");
        const at = await instantOf(caller.userId, input.at);
        if (at.getTime() <= Date.now())
            throw new McpRefusal(
                `${(await onTheirClock(caller.userId, [at]))[0]} has already passed. Pick a time ahead.`
            );
        const parsed = core.reminderSchema.parse({
            taskId: id,
            remindAt: at.toISOString(),
            note: input.note
        });
        await addReminder(caller.userId, id, parsed.remindAt, parsed.note);
        const [shown] = await onTheirClock(caller.userId, [at]);
        return text(`Reminder set for ${shown}.`, { at: parsed.remindAt });
    }
};

const cancelInput = z.object({
    reminder: z.string().uuid().describe("The reminder's id, as tasks_reminders returned it.")
});

const cancelReminderTool: McpTool<z.infer<typeof cancelInput>> = {
    name: "tasks_reminder_cancel",
    // i18n-ignore shown by the calling client, which has no locale to ask for
    title: "Cancel a task reminder",
    description:
        // i18n-ignore read by the calling model, not shown to a person
        "Cancel one of this account's task reminders before it goes off.",
    input: cancelInput,
    category: "productivity",
    scope: "tasks.manage",
    readOnly: false,
    idempotent: true,
    async run(input, caller) {
        const held = await prisma.taskReminder.findFirst({
            where: { id: input.reminder, userId: caller.userId },
            select: { id: true }
        });
        if (!held) throw new McpRefusal("This account has no reminder with that id.");
        await deleteReminder(caller.userId, input.reminder);
        return text("Cancelled.");
    }
};

/** The open tasks this key reaches, for `polaris_search`. */
export const TASK_SEARCH = defineMcpSearch({
    id: "tasks.tasks",
    app: "tasks",
    category: "productivity",
    scope: "tasks.read",
    async search(query, caller, limit) {
        const scope = await access.visibleScope(await actorFor(caller));
        const rows = await tasks.listTasks(
            { spaceIds: access.scopeSpaceIds(scope), listIds: scope.listIds },
            { openOnly: true, limit: 500 }
        );
        return preferMatches(rows, query, TASK_FIELDS, limit).map((row) => ({
            id: row.reference,
            name: row.name,
            kind: "task",
            where: `${row.spaceName} / ${row.listName}`,
            keywords: [row.reference, row.statusName],
            next: [
                { tool: "tasks_get", args: { task: row.reference } },
                { tool: "tasks_update", args: { task: row.reference } },
                { tool: "tasks_comment", args: { task: row.reference } },
                { tool: "tasks_remind", args: { task: row.reference } }
            ]
        }));
    }
});

export const TASK_TOOLS = [
    listSpacesTool,
    listTasksTool,
    getTaskTool,
    createTaskTool,
    updateTaskTool,
    commentTaskTool,
    listRemindersTool,
    remindTool,
    cancelReminderTool
] as unknown as McpTool<never>[];
