/**
 * The Tasks domain: what a work item is, where it lives, and every shape the
 * client is allowed to send about one.
 *
 * The hierarchy is Space > Folder > List > Task > Subtask, which is the shape
 * every mature work manager converges on and the one people arriving from
 * ClickUp, Asana or Linear already know. A task cannot exist outside a list, so
 * a list is always the unit that owns statuses, views and automations, while a
 * space owns the vocabulary shared across its lists (statuses, tags, custom
 * fields, members).
 *
 * Everything here is pure: constants, labels and Zod schemas. Persistence lives
 * in the service layer and the visual treatment in the UI, so both can change
 * without touching the contract in this file.
 */

import { z } from "zod";
import { emailField } from "./auth.js";

// ---------------------------------------------------------------------------
// Shared field primitives
// ---------------------------------------------------------------------------

/** True if the string contains a C0 control character. */
function hasControlChar(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) < 0x20) return true;
    }
    return false;
}

/** A name shown in a nav, a card or a cell: printable, trimmed, never blank. */
export const taskName = z
    .string()
    .trim()
    .min(1, "A name is required")
    .max(255, "Keep the name under 255 characters")
    .refine((value) => !hasControlChar(value), "The name must not contain control characters");

/** A shorter name for the containers a person scans down a sidebar. */
export const containerName = z
    .string()
    .trim()
    .min(1, "A name is required")
    .max(64, "Keep the name under 64 characters")
    .refine((value) => !hasControlChar(value), "The name must not contain control characters");

/** An optional free-text body. An empty string clears it rather than leaving the
 *  previous value behind, which is what a cleared editor should mean. */
export const taskDescription = z.string().trim().max(20000, "Keep the description under 20,000 characters");

/** Hex colours are stored, not class names, so a colour picked once renders the
 *  same in a chart, a badge and an exported view. */
export const hexColor = z
    .string()
    .trim()
    .regex(/^#[0-9a-fA-F]{6}$/, "Pick a colour");

const uuid = z.string().uuid();

/** A date sent by the client as an ISO string, or null to clear it. */
const isoDate = z.string().datetime({ offset: true }).nullable();

// ---------------------------------------------------------------------------
// Priorities
// ---------------------------------------------------------------------------

/**
 * Ordered most urgent first, and compared by index so a sort reads as "more
 * urgent than" instead of hard-coding the names. `none` is a real value rather
 * than a null: an unset priority is a deliberate state a filter can select.
 */
export const TASK_PRIORITIES = ["urgent", "high", "normal", "low", "none"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export const TASK_PRIORITY_LABELS: Record<TaskPriority, string> = {
    urgent: "Urgent",
    high: "High",
    normal: "Normal",
    low: "Low",
    none: "No priority"
};

export const TASK_PRIORITY_COLORS: Record<TaskPriority, string> = {
    urgent: "#f43f5e",
    high: "#f59e0b",
    normal: "#3b82f6",
    low: "#94a3b8",
    none: "#64748b"
};

/** How urgent a priority is, highest first. Used by sorts and by the automation
 *  engine's comparisons so both agree on what "higher priority" means. */
export function priorityRank(priority: TaskPriority): number {
    return TASK_PRIORITIES.indexOf(priority);
}

// ---------------------------------------------------------------------------
// Statuses
// ---------------------------------------------------------------------------

/**
 * A status is named by whoever owns the space, but every status is one of four
 * kinds so the product can reason about progress without reading names. "A task
 * is done" is a question about the kind, never about a label somebody typed.
 */
export const TASK_STATUS_TYPES = ["open", "active", "done", "closed"] as const;
export type TaskStatusType = (typeof TASK_STATUS_TYPES)[number];

export const TASK_STATUS_TYPE_LABELS: Record<TaskStatusType, string> = {
    open: "Not started",
    active: "Active",
    done: "Done",
    closed: "Closed"
};

export const TASK_STATUS_TYPE_HINTS: Record<TaskStatusType, string> = {
    open: "Work that has not been picked up yet.",
    active: "Work in progress. Counts as started but not finished.",
    done: "Finished work. Completing a task moves it to the first status of this kind.",
    closed: "Filed away without being completed: cancelled, duplicate, or won't do."
};

/** Whether a status kind stops the clock on a task. */
export function isFinishedStatus(type: TaskStatusType): boolean {
    return type === "done" || type === "closed";
}

/** The two halves of that answer, named once. A query asking the database for
 *  unfinished work and a screen asking the same question of a row cannot then
 *  disagree about what finished means. */
export const FINISHED_STATUS_TYPES = TASK_STATUS_TYPES.filter(isFinishedStatus);
export const UNFINISHED_STATUS_TYPES = TASK_STATUS_TYPES.filter((type) => !isFinishedStatus(type));

/**
 * The statuses a brand-new space starts with, and the colours people already
 * read them by: grey is untouched, blue is being worked, yellow is waiting on
 * somebody, brown is parked, green is finished. A space adds, renames and
 * recolours its own at any time - this is a starting point, not the set.
 *
 * "On hold" is `open` rather than `active`: a parked task is not in progress,
 * and every burndown, report and "what is being worked on" count reads the kind
 * rather than the name.
 *
 * "Blocked" is `open` for the same reason, and red because it is the one column
 * somebody is meant to notice from across the room. It is a stage, not the
 * whole answer: a task can also be blocked while sitting in any other column,
 * which is what `blockedUntil`, `blockedNote` and the dependency edges record.
 */
export const DEFAULT_TASK_STATUSES: readonly { name: string; type: TaskStatusType; color: string }[] = [
    { name: "To do", type: "open", color: "#64748b" },
    { name: "In progress", type: "active", color: "#3b82f6" },
    { name: "Blocked", type: "open", color: "#ef4444" },
    { name: "On hold", type: "open", color: "#92400e" },
    { name: "In review", type: "active", color: "#eab308" },
    { name: "Done", type: "done", color: "#22c55e" },
    { name: "Cancelled", type: "closed", color: "#71717a" }
];

/**
 * The labels every space starts with.
 *
 * Three, and all three about work that arrives rather than work that is planned:
 * a defect, a weakness somebody found, and the hardening that answers it. They
 * are the labels a team reaches for on their first bad afternoon, and a label
 * invented on that afternoon is a label nobody else uses.
 *
 * The colours are stated rather than derived from the name the way an ad-hoc tag
 * gets its own, because these three carry a meaning worth reading at a glance:
 * red is broken, orange is exposed, indigo is the work that closes it.
 */
export const DEFAULT_TASK_TAGS: readonly { name: string; color: string }[] = [
    { name: "bug", color: "#ef4444" },
    { name: "vulnerability", color: "#f97316" },
    { name: "security", color: "#6366f1" }
];

/**
 * What the list a container starts with is called. A space is created with one,
 * and a folder that is asked for a task before it holds anywhere to put one gets
 * the same, so the two are never a different thing under a different name.
 */
export const DEFAULT_LIST_NAME = "Tasks";

// ---------------------------------------------------------------------------
// Custom fields
// ---------------------------------------------------------------------------

/**
 * The column types a space can add to its tasks. Each one is stored as a string
 * and parsed by its type, which keeps the value table single-shaped while the
 * editor and the formatter stay type-aware.
 */
export const CUSTOM_FIELD_TYPES = [
    "text",
    "longText",
    "number",
    "money",
    "percent",
    "date",
    "checkbox",
    "dropdown",
    "labels",
    "url",
    "email",
    "phone",
    "people",
    "rating",
    "progress"
] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_LABELS: Record<CustomFieldType, string> = {
    text: "Text",
    longText: "Long text",
    number: "Number",
    money: "Money",
    percent: "Percent",
    date: "Date",
    checkbox: "Checkbox",
    dropdown: "Dropdown",
    labels: "Labels",
    url: "URL",
    email: "Email",
    phone: "Phone",
    people: "People",
    rating: "Rating",
    progress: "Progress"
};

/** One choice in a dropdown or labels field. */
export const customFieldOptionSchema = z.object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(64),
    color: hexColor
});

export type CustomFieldOption = z.infer<typeof customFieldOptionSchema>;

/**
 * Per-type settings. One object covers every type rather than a union, because
 * the editor renders one form and only the keys its type uses are read back;
 * a union here would mean a discriminant the UI has to maintain twice.
 */
export const customFieldConfigSchema = z.object({
    /** dropdown | labels */
    options: z.array(customFieldOptionSchema).max(50).optional(),
    /** number | money | percent | rating | progress */
    min: z.number().optional(),
    max: z.number().optional(),
    precision: z.number().int().min(0).max(6).optional(),
    /** money: an ISO 4217 code, rendered by the display-preferences formatter. */
    currency: z.string().trim().length(3).optional(),
    /** date: whether the time of day is part of the value. */
    includeTime: z.boolean().optional(),
    /** people: more than one person may be picked. */
    multiple: z.boolean().optional()
});

export type CustomFieldConfig = z.infer<typeof customFieldConfigSchema>;

export const customFieldSchema = z.object({
    spaceId: uuid,
    name: containerName,
    type: z.enum(CUSTOM_FIELD_TYPES),
    config: customFieldConfigSchema.default({}),
    required: z.boolean().default(false),
    /** Shown on the card and in the table without opening the task. */
    showOnCard: z.boolean().default(false)
});

export type CustomFieldInput = z.infer<typeof customFieldSchema>;

// ---------------------------------------------------------------------------
// Relationships between tasks
// ---------------------------------------------------------------------------

/**
 * `blocks` and `waitsOn` are the two directions of one edge; only `blocks` is
 * ever stored, so a dependency cannot disagree with itself. `relates` is an
 * undirected link that carries no scheduling meaning.
 */
export const DEPENDENCY_TYPES = ["blocks", "relates"] as const;
export type DependencyType = (typeof DEPENDENCY_TYPES)[number];

export const dependencySchema = z.object({
    taskId: uuid,
    relatedTaskId: uuid,
    type: z.enum(DEPENDENCY_TYPES).default("blocks"),
    /** true stores the edge the other way round, which is how the UI offers
     *  "waiting on" without a second row shape. */
    reverse: z.boolean().default(false)
});

export type DependencyInput = z.infer<typeof dependencySchema>;

/**
 * Why a task is held up, in the words of whoever recorded it.
 *
 * Three things can hold work, and only one of them is a question the product can
 * answer for itself: an unfinished task this one depends on, which is the edge
 * above. The other two are what a person knows and the product cannot - a date
 * the work is waiting for, and a reason like this one. All three read the same
 * on a board, because from the outside "blocked" is one state however it came
 * about.
 *
 * Short on purpose: a paragraph about it belongs in the description or a
 * comment, and this line has to fit on a card's tooltip.
 */
export const taskBlockNote = z.string().trim().max(200);

// ---------------------------------------------------------------------------
// Views, grouping, sorting
// ---------------------------------------------------------------------------

export const TASK_VIEW_TYPES = ["list", "board", "table", "calendar", "gantt"] as const;
export type TaskViewType = (typeof TASK_VIEW_TYPES)[number];

export const TASK_VIEW_LABELS: Record<TaskViewType, string> = {
    list: "List",
    board: "Board",
    table: "Table",
    calendar: "Calendar",
    gantt: "Gantt"
};

export const TASK_GROUP_FIELDS = [
    "status",
    "assignee",
    "priority",
    "dueDate",
    "tag",
    "list",
    "blocked",
    "none"
] as const;
export type TaskGroupField = (typeof TASK_GROUP_FIELDS)[number];

export const TASK_GROUP_LABELS: Record<TaskGroupField, string> = {
    status: "Status",
    assignee: "Assignee",
    priority: "Priority",
    dueDate: "Due date",
    tag: "Tag",
    list: "List",
    blocked: "Blocked",
    none: "No grouping"
};

export const TASK_SORT_FIELDS = [
    "manual",
    "name",
    "status",
    "priority",
    "dueDate",
    "startDate",
    "createdAt",
    "updatedAt",
    "points",
    "timeEstimate"
] as const;
export type TaskSortField = (typeof TASK_SORT_FIELDS)[number];

export const TASK_SORT_LABELS: Record<TaskSortField, string> = {
    manual: "Manual order",
    name: "Name",
    status: "Status",
    priority: "Priority",
    dueDate: "Due date",
    startDate: "Start date",
    createdAt: "Created",
    updatedAt: "Updated",
    points: "Points",
    timeEstimate: "Estimate"
};

/**
 * Priority rather than manual order, because manual order is only meaningful
 * once somebody has dragged something: on a list nobody has arranged by hand it
 * is creation order wearing a different name, which puts the most urgent work
 * wherever it happened to be typed. A view that was arranged by hand still says
 * so - this is only what an unarranged one opens on.
 */
export const taskSortSchema = z.object({
    field: z.enum(TASK_SORT_FIELDS).default("priority"),
    direction: z.enum(["asc", "desc"]).default("asc")
});

export type TaskSort = z.infer<typeof taskSortSchema>;

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

export const TASK_FILTER_FIELDS = [
    "status",
    "statusType",
    "assignee",
    "watcher",
    "createdBy",
    "priority",
    "tag",
    "list",
    "dueDate",
    "startDate",
    "createdAt",
    "name",
    "points",
    "timeEstimate",
    "archived",
    "blocked",
    "customField"
] as const;
export type TaskFilterField = (typeof TASK_FILTER_FIELDS)[number];

export const TASK_FILTER_LABELS: Record<TaskFilterField, string> = {
    status: "Status",
    statusType: "Status kind",
    assignee: "Assignee",
    watcher: "Watcher",
    createdBy: "Created by",
    priority: "Priority",
    tag: "Tag",
    list: "List",
    dueDate: "Due date",
    startDate: "Start date",
    createdAt: "Created",
    name: "Name",
    points: "Points",
    timeEstimate: "Estimate",
    archived: "Archived",
    blocked: "Blocked",
    customField: "Custom field"
};

/**
 * Operators are shared across field kinds and validated against the field when
 * the filter is applied, rather than split into per-kind unions. The set stays
 * small on purpose: every operator here has an obvious meaning in a sentence
 * read left to right ("assignee is any of ...", "due date is before ...").
 */
export const TASK_FILTER_OPERATORS = [
    "is",
    "isNot",
    "anyOf",
    "noneOf",
    "contains",
    "notContains",
    "isSet",
    "isNotSet",
    "before",
    "after",
    "between",
    "gt",
    "lt"
] as const;
export type TaskFilterOperator = (typeof TASK_FILTER_OPERATORS)[number];

export const TASK_FILTER_OPERATOR_LABELS: Record<TaskFilterOperator, string> = {
    is: "is",
    isNot: "is not",
    anyOf: "is any of",
    noneOf: "is none of",
    contains: "contains",
    notContains: "does not contain",
    isSet: "is set",
    isNotSet: "is not set",
    before: "is before",
    after: "is after",
    between: "is between",
    gt: "is greater than",
    lt: "is less than"
};

/**
 * Relative date tokens a saved view can hold. A view filtered to "today" has to
 * still mean today tomorrow, so the token is stored and resolved at read time
 * rather than being frozen into a date when the view was saved.
 */
export const RELATIVE_DATES = [
    "today",
    "tomorrow",
    "yesterday",
    "thisWeek",
    "nextWeek",
    "lastWeek",
    "thisMonth",
    "nextMonth",
    "overdue"
] as const;
export type RelativeDate = (typeof RELATIVE_DATES)[number];

export const RELATIVE_DATE_LABELS: Record<RelativeDate, string> = {
    today: "Today",
    tomorrow: "Tomorrow",
    yesterday: "Yesterday",
    thisWeek: "This week",
    nextWeek: "Next week",
    lastWeek: "Last week",
    thisMonth: "This month",
    nextMonth: "Next month",
    overdue: "Overdue"
};

export const taskFilterConditionSchema = z.object({
    field: z.enum(TASK_FILTER_FIELDS),
    operator: z.enum(TASK_FILTER_OPERATORS),
    /** Values are always strings so one column shape carries ids, enum members,
     *  relative-date tokens and numbers; the applier parses per field. */
    values: z.array(z.string().max(255)).max(50).default([]),
    /** Only for `customField`: which field the condition is about. */
    fieldId: uuid.optional()
});

export type TaskFilterCondition = z.infer<typeof taskFilterConditionSchema>;

export const taskFilterSchema = z.object({
    match: z.enum(["all", "any"]).default("all"),
    conditions: z.array(taskFilterConditionSchema).max(25).default([])
});

export type TaskFilter = z.infer<typeof taskFilterSchema>;

export const EMPTY_FILTER: TaskFilter = { match: "all", conditions: [] };

/** Read a stored filter, falling back to "no filter" for anything unreadable so
 *  a corrupt view still opens instead of erroring the page. */
export function parseTaskFilter(raw: string | null | undefined): TaskFilter {
    if (!raw) return EMPTY_FILTER;
    try {
        const parsed = taskFilterSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : EMPTY_FILTER;
    } catch {
        return EMPTY_FILTER;
    }
}

export const taskViewSchema = z.object({
    name: containerName,
    type: z.enum(TASK_VIEW_TYPES).default("list"),
    listId: uuid.nullable().default(null),
    spaceId: uuid.nullable().default(null),
    groupBy: z.enum(TASK_GROUP_FIELDS).default("status"),
    sort: taskSortSchema.default({ field: "manual", direction: "asc" }),
    filter: taskFilterSchema.default(EMPTY_FILTER),
    /** Columns shown in table view, by field id or `custom:<uuid>`. */
    columns: z.array(z.string().max(64)).max(30).default([]),
    /** Whether subtasks are listed alongside their parent or nested under it. */
    showSubtasks: z.boolean().default(true),
    showClosed: z.boolean().default(false),
    /** A shared view belongs to the list; a private one only to its author. */
    shared: z.boolean().default(true)
});

export type TaskViewInput = z.infer<typeof taskViewSchema>;

// ---------------------------------------------------------------------------
// Recurrence
// ---------------------------------------------------------------------------

export const RECURRENCE_MODES = ["daily", "weekly", "monthly", "yearly"] as const;
export type RecurrenceMode = (typeof RECURRENCE_MODES)[number];

export const RECURRENCE_MODE_LABELS: Record<RecurrenceMode, string> = {
    daily: "Daily",
    weekly: "Weekly",
    monthly: "Monthly",
    yearly: "Yearly"
};

/**
 * `schedule` repeats on the calendar whatever the task is doing, which is what a
 * standing meeting wants. `completion` starts the next interval from the moment
 * the task was finished, which is what "water the plants every 3 days" wants.
 * Getting these two confused is the classic recurring-task bug, so they are
 * named rather than inferred.
 */
export const RECURRENCE_BASES = ["schedule", "completion"] as const;
export type RecurrenceBase = (typeof RECURRENCE_BASES)[number];

export const recurrenceSchema = z.object({
    mode: z.enum(RECURRENCE_MODES),
    /** Every N days/weeks/months/years. */
    interval: z.number().int().min(1).max(365).default(1),
    /** weekly: 0 (Sunday) to 6, at least one when the mode is weekly. */
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).default([]),
    /** monthly: which day of the month, clamped to the length of short months. */
    dayOfMonth: z.number().int().min(1).max(31).optional(),
    /** yearly: 0 (January) to 11. */
    month: z.number().int().min(0).max(11).optional(),
    basis: z.enum(RECURRENCE_BASES).default("schedule"),
    /** Stop repeating after this many occurrences, or on this date. Both unset
     *  means it repeats until somebody turns it off. */
    endsAfter: z.number().int().min(1).max(1000).optional(),
    endsOn: z.string().datetime({ offset: true }).optional()
});

export type Recurrence = z.infer<typeof recurrenceSchema>;

export function parseRecurrence(raw: string | null | undefined): Recurrence | null {
    if (!raw) return null;
    try {
        const parsed = recurrenceSchema.safeParse(JSON.parse(raw));
        return parsed.success ? parsed.data : null;
    } catch {
        return null;
    }
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

/**
 * What can start a rule. Every trigger names a fact about a task that the
 * service layer already emits, so adding one never means a new event bus.
 */
export const AUTOMATION_TRIGGERS = [
    "task.created",
    "task.statusChanged",
    "task.priorityChanged",
    "task.assigneeAdded",
    "task.assigneeRemoved",
    "task.tagAdded",
    "task.moved",
    "task.dueDateSet",
    "task.commentAdded",
    "task.completed"
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_TRIGGER_LABELS: Record<AutomationTrigger, string> = {
    "task.created": "A task is created",
    "task.statusChanged": "Status changes",
    "task.priorityChanged": "Priority changes",
    "task.assigneeAdded": "An assignee is added",
    "task.assigneeRemoved": "An assignee is removed",
    "task.tagAdded": "A tag is added",
    "task.moved": "A task moves list",
    "task.dueDateSet": "A due date is set",
    "task.commentAdded": "A comment is posted",
    "task.completed": "A task is completed"
};

export const AUTOMATION_ACTIONS = [
    "setStatus",
    "setPriority",
    "addAssignee",
    "removeAssignee",
    "addTag",
    "removeTag",
    "setDueDate",
    "moveToList",
    "addComment",
    "addWatcher",
    "archive",
    "createSubtask"
] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTIONS)[number];

export const AUTOMATION_ACTION_LABELS: Record<AutomationActionType, string> = {
    setStatus: "Change status",
    setPriority: "Change priority",
    addAssignee: "Assign to",
    removeAssignee: "Unassign",
    addTag: "Add tag",
    removeTag: "Remove tag",
    setDueDate: "Set due date",
    moveToList: "Move to list",
    addComment: "Post a comment",
    addWatcher: "Add a watcher",
    archive: "Archive the task",
    createSubtask: "Create a subtask"
};

export const automationActionSchema = z.object({
    type: z.enum(AUTOMATION_ACTIONS),
    /** The id this action points at (a status, a user, a tag, a list). */
    targetId: z.string().trim().max(255).optional(),
    /** Free text for the comment and subtask actions. */
    text: z.string().trim().max(2000).optional(),
    /** setDueDate: days from the moment the rule ran. Negative moves it earlier. */
    offsetDays: z.number().int().min(-365).max(365).optional()
});

export type AutomationAction = z.infer<typeof automationActionSchema>;

export const automationSchema = z.object({
    listId: uuid.nullable().default(null),
    spaceId: uuid.nullable().default(null),
    name: containerName,
    trigger: z.enum(AUTOMATION_TRIGGERS),
    /** Reuses the view filter, so "only urgent bugs" means the same thing to a
     *  rule as it does to a saved view the reader already understands. */
    conditions: taskFilterSchema.default(EMPTY_FILTER),
    actions: z.array(automationActionSchema).min(1, "Add at least one action").max(10),
    enabled: z.boolean().default(true)
});

export type AutomationInput = z.infer<typeof automationSchema>;

// ---------------------------------------------------------------------------
// Intake forms
// ---------------------------------------------------------------------------

export const FORM_FIELD_TYPES = ["text", "longText", "email", "number", "date", "dropdown", "checkbox"] as const;
export type FormFieldType = (typeof FORM_FIELD_TYPES)[number];

export const FORM_FIELD_LABELS: Record<FormFieldType, string> = {
    text: "Short answer",
    longText: "Paragraph",
    email: "Email",
    number: "Number",
    date: "Date",
    dropdown: "Choice",
    checkbox: "Checkbox"
};

/**
 * A form question. `mapsTo` decides where the answer lands on the created task:
 * the built-in slots, a custom field by id, or nothing (the answer is appended
 * to the description so it is never silently lost).
 */
export const formFieldSchema = z.object({
    id: z.string().trim().min(1).max(64),
    label: z.string().trim().min(1).max(200),
    type: z.enum(FORM_FIELD_TYPES),
    required: z.boolean().default(false),
    help: z.string().trim().max(300).optional(),
    options: z.array(z.string().trim().min(1).max(100)).max(30).default([]),
    mapsTo: z.string().trim().max(80).default("")
});

export type FormField = z.infer<typeof formFieldSchema>;

/** The task slots a form answer can be routed into, beyond a custom field. */
export const FORM_TARGETS = ["name", "description", "priority", "dueDate"] as const;

export const formSchema = z.object({
    listId: uuid,
    name: containerName,
    intro: z.string().trim().max(1000).default(""),
    fields: z.array(formFieldSchema).min(1, "A form needs at least one question").max(30),
    /** Where the answers land when a question is not mapped to a field. */
    defaultStatusId: uuid.nullable().default(null),
    /** Shown after a submission goes through. */
    confirmation: z.string().trim().max(500).default("Thanks. Your request has been received."),
    /** An open form accepts anonymous submissions from anyone with the link. */
    requireLogin: z.boolean().default(false),
    enabled: z.boolean().default(true)
});

export type FormInput = z.infer<typeof formSchema>;

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

/**
 * How a goal measures itself. `tasks` counts completed tasks in the lists it
 * watches, which is the only target type that fills itself in; the rest are
 * updated by hand because nothing else in Polaris knows their number.
 */
export const GOAL_TARGET_TYPES = ["number", "currency", "percent", "boolean", "tasks"] as const;
export type GoalTargetType = (typeof GOAL_TARGET_TYPES)[number];

export const GOAL_TARGET_LABELS: Record<GoalTargetType, string> = {
    number: "Number",
    currency: "Currency",
    percent: "Percent",
    boolean: "Done or not",
    tasks: "Tasks completed"
};

export const goalTargetSchema = z.object({
    name: containerName,
    type: z.enum(GOAL_TARGET_TYPES),
    startValue: z.number().default(0),
    targetValue: z.number().default(100),
    currentValue: z.number().default(0),
    unit: z.string().trim().max(16).default(""),
    /** `tasks` targets follow this list. */
    listId: uuid.nullable().default(null)
});

export type GoalTargetInput = z.infer<typeof goalTargetSchema>;

export const goalSchema = z.object({
    name: containerName,
    description: z.string().trim().max(2000).default(""),
    spaceId: uuid.nullable().default(null),
    dueDate: isoDate.default(null),
    color: hexColor.default("#7c5cff"),
    ownerId: uuid.optional()
});

export type GoalInput = z.infer<typeof goalSchema>;

// ---------------------------------------------------------------------------
// Containers
// ---------------------------------------------------------------------------

/**
 * `private` keeps a space to its owner and the people added to it. `internal`
 * opens it to anyone on the instance holding `tasks.read`, which is what a
 * household or a single team running one Polaris usually wants.
 */
export const SPACE_VISIBILITIES = ["private", "internal"] as const;
export type SpaceVisibility = (typeof SPACE_VISIBILITIES)[number];

/** What a member may do inside a space. Ordered least to most and compared by
 *  index, so a check reads as "at least a member". The owner outranks all. */
export const SPACE_ROLES = ["guest", "member", "admin"] as const;
export type SpaceRole = (typeof SPACE_ROLES)[number];

export const SPACE_ROLE_LABELS: Record<SpaceRole, string> = {
    guest: "Guest",
    member: "Member",
    admin: "Admin"
};

export const SPACE_ROLE_HINTS: Record<SpaceRole, string> = {
    guest: "Read tasks and comment on the ones they are assigned to.",
    member: "Create and edit tasks, lists and views.",
    admin: "Everything a member can do, plus statuses, fields, automations and deletion."
};

export function spaceRoleAtLeast(role: SpaceRole, minimum: SpaceRole): boolean {
    return SPACE_ROLES.indexOf(role) >= SPACE_ROLES.indexOf(minimum);
}

/** The stronger of two roles, so a grant on a folder can only ever add to what
 *  the space already gave somebody and never quietly take it away. */
export function strongerRole(left: SpaceRole, right: SpaceRole): SpaceRole {
    return SPACE_ROLES.indexOf(left) >= SPACE_ROLES.indexOf(right) ? left : right;
}

export const spaceSchema = z.object({
    name: containerName,
    description: z.string().trim().max(500).default(""),
    color: hexColor.default("#7c5cff"),
    visibility: z.enum(SPACE_VISIBILITIES).default("private")
});

export type SpaceInput = z.infer<typeof spaceSchema>;

/**
 * How deep folders may nest. Deep enough for the arrangement people actually
 * keep - agency > client > project > phase - and shallow enough that the
 * sidebar's indentation and a breadcrumb still fit on one line.
 */
export const FOLDER_DEPTH_LIMIT = 8;

export const folderSchema = z.object({
    spaceId: uuid,
    /** The folder this one sits inside, or null for a folder at the space root. */
    parentId: uuid.nullable().default(null),
    name: containerName
});

export type FolderInput = z.infer<typeof folderSchema>;

/**
 * Where a folder or a list was dropped in the sidebar: the container it landed
 * in, plus the two rows it landed between. Neighbours rather than an index, for
 * the same reason a task drag reports them - two people rearranging at once
 * cannot renumber each other.
 */
export const containerMoveSchema = z.object({
    parentId: uuid.nullable().default(null),
    beforeId: uuid.nullable().default(null),
    afterId: uuid.nullable().default(null)
});

export type ContainerMove = z.infer<typeof containerMoveSchema>;

export const listSchema = z.object({
    spaceId: uuid,
    folderId: uuid.nullable().default(null),
    name: containerName,
    description: z.string().trim().max(500).default(""),
    color: hexColor.optional(),
    startDate: isoDate.default(null),
    dueDate: isoDate.default(null)
});

export type ListInput = z.infer<typeof listSchema>;

export const statusSchema = z.object({
    spaceId: uuid,
    name: containerName,
    type: z.enum(TASK_STATUS_TYPES),
    color: hexColor
});

export const tagSchema = z.object({
    spaceId: uuid,
    name: containerName,
    color: hexColor
});

export const sprintSchema = z.object({
    spaceId: uuid,
    /** The folder whose work this sprint plans, or null for a sprint the whole
     *  space runs. A project kept as a folder gets its own sprints without a
     *  space per project. */
    folderId: uuid.nullable().default(null),
    name: containerName,
    goal: z.string().trim().max(500).default(""),
    startDate: z.string().datetime({ offset: true }),
    endDate: z.string().datetime({ offset: true })
});

export type SprintInput = z.infer<typeof sprintSchema>;

// ---------------------------------------------------------------------------
// Tasks
// ---------------------------------------------------------------------------

/**
 * Everything a task can be created with. Only the list and the name are
 * required: a task somebody types into a list should exist the moment they hit
 * enter, and be filled in afterwards.
 */
export const taskCreateSchema = z.object({
    listId: uuid,
    name: taskName,
    description: taskDescription.default(""),
    parentId: uuid.nullable().default(null),
    statusId: uuid.nullable().default(null),
    priority: z.enum(TASK_PRIORITIES).default("none"),
    assigneeIds: z.array(uuid).max(25).default([]),
    tagIds: z.array(uuid).max(25).default([]),
    startDate: isoDate.default(null),
    dueDate: isoDate.default(null),
    /** Whether the dates carry a time of day, or are all-day. */
    timed: z.boolean().default(false),
    /** Minutes. Entered as "2h 30m" and parsed before it reaches here. */
    timeEstimate: z.number().int().min(0).max(60 * 24 * 365).nullable().default(null),
    points: z.number().int().min(0).max(1000).nullable().default(null),
    sprintId: uuid.nullable().default(null),
    milestone: z.boolean().default(false),
    recurrence: recurrenceSchema.nullable().default(null)
});

export type TaskCreateInput = z.infer<typeof taskCreateSchema>;

/** A change to one task. Every field is optional and only the keys present are
 *  written, so a card edit never has to send the whole task back. */
export const taskUpdateSchema = z.object({
    taskId: uuid,
    name: taskName.optional(),
    description: taskDescription.optional(),
    statusId: uuid.optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    assigneeIds: z.array(uuid).max(25).optional(),
    tagIds: z.array(uuid).max(25).optional(),
    startDate: isoDate.optional(),
    dueDate: isoDate.optional(),
    timed: z.boolean().optional(),
    timeEstimate: z.number().int().min(0).max(60 * 24 * 365).nullable().optional(),
    points: z.number().int().min(0).max(1000).nullable().optional(),
    sprintId: uuid.nullable().optional(),
    parentId: uuid.nullable().optional(),
    milestone: z.boolean().optional(),
    archived: z.boolean().optional(),
    /** Null clears the block; a date sets one that lifts itself when it passes. */
    blockedUntil: isoDate.optional(),
    /** An empty string clears the stated reason, which is how "unblock" arrives. */
    blockedNote: taskBlockNote.optional(),
    recurrence: recurrenceSchema.nullable().optional()
});

export type TaskUpdateInput = z.infer<typeof taskUpdateSchema>;

/** Where a dragged task landed: a list, a group within the view, and the two
 *  neighbours it was dropped between. The service turns the neighbours into an
 *  order key, so the client never invents one. */
export const taskMoveSchema = z.object({
    taskId: uuid,
    listId: uuid.optional(),
    /** Explicit null clears the status, which is what dropping a card into the
     *  "No status" column means. Omitted leaves it alone, which is what a drag
     *  inside one column means. */
    statusId: uuid.nullable().optional(),
    beforeId: uuid.nullable().default(null),
    afterId: uuid.nullable().default(null)
});

export type TaskMoveInput = z.infer<typeof taskMoveSchema>;

/**
 * The order a screen is looking at, made permanent.
 *
 * A view opens in the order the engine decided - most urgent first - and nothing
 * is written down until somebody drags a task somewhere. That drag means "I want
 * it here", which only holds if the rest of the screen keeps the places it was
 * showing, so the whole arrangement is sent rather than the one row that moved.
 * The cap matches the most tasks a screen ever loads at once.
 */
export const taskArrangeSchema = z.object({
    taskIds: z.array(uuid).min(2).max(2000)
});

export type TaskArrangeInput = z.infer<typeof taskArrangeSchema>;

/**
 * The most tasks one write may carry.
 *
 * A screen loads more than this, and a shift-click can reach across all of it in
 * one gesture, so the number is not private to the schema: the screen holds a
 * selection to it and says what it left out, because a selection the server
 * refuses whole is a change that does nothing and explains nothing.
 */
export const TASK_SELECTION_MAX = 500;

/** A change applied to a selection. Kept separate from taskUpdateSchema so the
 *  fields a bulk edit may touch are an explicit, reviewable list. */
export const taskBulkSchema = z.object({
    taskIds: z.array(uuid).min(1).max(TASK_SELECTION_MAX),
    statusId: uuid.optional(),
    priority: z.enum(TASK_PRIORITIES).optional(),
    addAssigneeIds: z.array(uuid).max(25).optional(),
    removeAssigneeIds: z.array(uuid).max(25).optional(),
    addTagIds: z.array(uuid).max(25).optional(),
    removeTagIds: z.array(uuid).max(25).optional(),
    dueDate: isoDate.optional(),
    listId: uuid.optional(),
    sprintId: uuid.nullable().optional(),
    archived: z.boolean().optional()
});

export type TaskBulkInput = z.infer<typeof taskBulkSchema>;

/** A selection to delete. Kept apart from the bulk edit so a delete can never
 *  arrive carrying a field somebody meant to change instead. */
export const taskSelectionSchema = z.object({
    taskIds: z.array(uuid).min(1).max(TASK_SELECTION_MAX)
});

export type TaskSelectionInput = z.infer<typeof taskSelectionSchema>;

export const commentSchema = z.object({
    taskId: uuid,
    body: z.string().trim().min(1, "Write something first").max(10000),
    parentId: uuid.nullable().default(null),
    /** A comment can be handed to somebody as an action item. */
    assignedToId: uuid.nullable().default(null)
});

export type CommentInput = z.infer<typeof commentSchema>;

export const checklistSchema = z.object({
    taskId: uuid,
    name: containerName
});

/** Where a checklist was dropped among the others on its task. */
export const checklistMoveSchema = z.object({
    beforeId: uuid.nullable().default(null),
    afterId: uuid.nullable().default(null)
});

/** Where a step was dropped: which checklist it landed in - dragging one from
 *  "Design" to "Build" is the same gesture as moving it up two rows - and the
 *  two steps it landed between. */
export const checklistItemMoveSchema = z.object({
    checklistId: uuid,
    beforeId: uuid.nullable().default(null),
    afterId: uuid.nullable().default(null)
});

export const checklistItemSchema = z.object({
    checklistId: uuid,
    name: taskName,
    assigneeId: uuid.nullable().default(null)
});

/** A stretch of tracked time. Either a duration in seconds for a manual entry,
 *  or a running timer that has no end yet. */
export const timeEntrySchema = z.object({
    taskId: uuid,
    /** Seconds. Entered as "1h 30m" and parsed before it reaches here. */
    duration: z.number().int().min(1).max(24 * 3600 * 31),
    startedAt: z.string().datetime({ offset: true }).optional(),
    note: z.string().trim().max(500).default(""),
    billable: z.boolean().default(false)
});

export type TimeEntryInput = z.infer<typeof timeEntrySchema>;

export const reminderSchema = z.object({
    taskId: uuid,
    remindAt: z.string().datetime({ offset: true }),
    note: z.string().trim().max(200).default("")
});

/**
 * Turning a task's public link on or off. Off deletes the link rather than
 * suspending it, so turning it back on mints a new token: a link that was pasted
 * somewhere it should not have been stops working for good.
 */
export const taskShareSchema = z.object({
    taskId: uuid,
    enabled: z.boolean(),
    /** Whether the public page carries the discussion as well as the work. */
    showComments: z.boolean().default(false)
});

export type TaskShareInput = z.infer<typeof taskShareSchema>;

/**
 * Sending a task to people. Members get the private link, which only opens for
 * somebody who can already see the space; addresses outside Polaris get the
 * public one, which is why the caller has to have turned it on first.
 */
export const taskShareEmailSchema = z
    .object({
        taskId: uuid,
        userIds: z.array(uuid).max(20, "Twenty people at a time").default([]),
        emails: z.array(emailField.toLowerCase()).max(20, "Twenty addresses at a time").default([]),
        note: z.string().trim().max(1000).default("")
    })
    .refine((input) => input.userIds.length + input.emails.length > 0, "Choose who to send it to");

export type TaskShareEmailInput = z.infer<typeof taskShareEmailSchema>;

export const docSchema = z.object({
    spaceId: uuid.nullable().default(null),
    /** The folder this page belongs to, or null for a page the space shares.
     *  A page written inside a client's folder is reachable by that client and
     *  by nobody standing outside it. */
    folderId: uuid.nullable().default(null),
    parentId: uuid.nullable().default(null),
    title: containerName,
    body: z.string().max(200000).default(""),
    icon: z.string().trim().max(8).default("")
});

export type DocInput = z.infer<typeof docSchema>;
