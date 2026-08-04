/**
 * The Tasks engine: everything the app decides about work items that does not
 * need a database to decide it.
 *
 * Filtering, grouping, sorting, ordering, recurrence and automation matching all
 * live here rather than in a query builder, for one reason: the same rules have
 * to hold in three places at once. A saved view filters on the server, the board
 * re-filters optimistically after a drag before the write lands, and an
 * automation asks "does this task match?" about a task it was handed. Three
 * implementations of "is any of" would drift within a release, so there is one,
 * it is pure, and it is tested directly.
 *
 * Every function that depends on the current time takes it as an argument. That
 * keeps the module deterministic and makes "what does this view show at 23:59"
 * a test rather than a question.
 */

import * as work from "./schemas/tasks.js";

// ---------------------------------------------------------------------------
// The shape everything here reasons about
// ---------------------------------------------------------------------------

/**
 * The facts about a task that the engine needs. Deliberately not the database
 * row: the server passes a projection and the client passes what it already has
 * in state, so neither has to carry fields a filter never reads.
 */
export interface TaskFacts {
    readonly id: string;
    readonly name: string;
    readonly listId: string;
    readonly parentId: string | null;
    readonly statusId: string | null;
    readonly statusType: work.TaskStatusType;
    readonly priority: work.TaskPriority;
    readonly assigneeIds: readonly string[];
    readonly tagIds: readonly string[];
    readonly watcherIds?: readonly string[];
    readonly createdById: string | null;
    readonly startDate: Date | null;
    readonly dueDate: Date | null;
    /** Whether the due date carries a time of day. An all-day task is due at the
     *  end of its day, which is what decides when it turns overdue. */
    readonly timed?: boolean;
    readonly createdAt: Date;
    readonly updatedAt?: Date | null;
    readonly completedAt?: Date | null;
    readonly points: number | null;
    /** Minutes. */
    readonly timeEstimate: number | null;
    readonly archived: boolean;
    readonly order: number;
    /** Whether something is holding this task up - unfinished work it depends
     *  on, a date it waits for, or a reason somebody wrote down. Decided where
     *  the task is loaded, since only the first of the three is a question about
     *  other rows. */
    readonly blocked?: boolean;
    /** Custom field values keyed by field id, as stored (always a string). */
    readonly customValues?: Readonly<Record<string, string>>;
}

// ---------------------------------------------------------------------------
// Manual ordering
// ---------------------------------------------------------------------------

/**
 * Manual order is a sparse float rather than a dense integer, so dropping a task
 * between two others writes one row instead of renumbering everything below it.
 * The gap halves on every insertion at the same spot, which is why the caller
 * checks `needsRebalance` and re-spaces the group when the gap gets too thin for
 * a double to represent honestly.
 */
export const ORDER_STEP = 1024;

/** Below this, two neighbours are too close to keep splitting reliably. */
export const MIN_ORDER_GAP = 0.001;

/**
 * The order key for a task dropped between two neighbours. Either side may be
 * null, meaning "the end of the list" in that direction.
 */
export function orderBetween(before: number | null, after: number | null): number {
    if (before === null && after === null) return ORDER_STEP;
    if (before === null) return (after as number) - ORDER_STEP;
    if (after === null) return before + ORDER_STEP;
    return (before + after) / 2;
}

/** Whether the gap the drop landed in is too small to keep splitting. */
export function needsRebalance(before: number | null, after: number | null): boolean {
    if (before === null || after === null) return false;
    return Math.abs(after - before) < MIN_ORDER_GAP;
}

/** Evenly spaced order keys for a group being re-spaced after a rebalance. */
export function rebalanceOrders(count: number): number[] {
    return Array.from({ length: count }, (_, index) => (index + 1) * ORDER_STEP);
}

/**
 * The sequence left behind by a task dropped between two others.
 *
 * Needed when a screen was in the order the engine chose rather than one anybody
 * wrote down: the drop has to be applied to what was on screen before that
 * arrangement can be kept, and the drop is described by its neighbours the same
 * way every other move is. A neighbour that is not in the sequence - it was
 * filtered out from under the pointer - puts the task at the end rather than
 * dropping it.
 */
export function arrangeAround(
    ids: readonly string[],
    movedId: string,
    position: { beforeId: string | null; afterId: string | null }
): string[] {
    const without = ids.filter((id) => id !== movedId);
    const after = position.afterId ? without.indexOf(position.afterId) : -1;
    const before = position.beforeId ? without.indexOf(position.beforeId) : -1;
    const landing = after >= 0 ? after : before >= 0 ? before + 1 : without.length;
    without.splice(landing, 0, movedId);
    return without;
}

// ---------------------------------------------------------------------------
// Durations
// ---------------------------------------------------------------------------

/**
 * A working day, not a calendar one. An estimate of "2d" means two days of work,
 * which is the only reading that makes a timesheet add up.
 */
export const WORKDAY_MINUTES = 8 * 60;
export const WORKWEEK_MINUTES = 5 * WORKDAY_MINUTES;

const DURATION_UNITS: Readonly<Record<string, number>> = {
    w: WORKWEEK_MINUTES,
    d: WORKDAY_MINUTES,
    h: 60,
    m: 1
};

/**
 * Parse what a person types into an estimate box: "2h 30m", "1.5h", "3d", "90".
 * A bare number is minutes, which is what the box's placeholder promises.
 * Returns null for anything unreadable so the caller can refuse it rather than
 * silently storing a zero.
 */
export function parseDurationMinutes(input: string): number | null {
    const text = input.trim().toLowerCase();
    if (!text) return null;
    if (/^\d+(\.\d+)?$/.test(text)) return Math.round(Number(text));

    const matches = text.matchAll(/(\d+(?:\.\d+)?)\s*([wdhm])/g);
    let total = 0;
    let seen = false;
    let consumed = 0;
    for (const match of matches) {
        const [whole, amount, unit] = match;
        total += Number(amount) * (DURATION_UNITS[unit as string] ?? 0);
        consumed += whole.length;
        seen = true;
    }
    // Reject input with characters that were not part of any unit, so "2h zzz"
    // is a typo the user is told about instead of a silent 120.
    if (!seen || consumed !== text.replace(/\s+/g, "").length) return null;
    return Math.round(total);
}

/** Minutes as the estimate box shows them back: "2h 30m", "3d", "45m". */
export function formatDurationMinutes(minutes: number | null | undefined): string {
    if (minutes === null || minutes === undefined || !Number.isFinite(minutes) || minutes <= 0) return "";
    let left = Math.round(minutes);
    const parts: string[] = [];
    for (const [unit, size] of [
        ["d", WORKDAY_MINUTES],
        ["h", 60],
        ["m", 1]
    ] as const) {
        const amount = Math.floor(left / size);
        if (amount > 0) {
            parts.push(`${amount}${unit}`);
            left -= amount * size;
        }
    }
    return parts.join(" ");
}

/** Tracked time as a running timer shows it: "1:05:32". */
export function formatTimer(seconds: number): string {
    const safe = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(safe / 3600);
    const minutes = Math.floor((safe % 3600) / 60);
    const rest = safe % 60;
    const pad = (value: number) => String(value).padStart(2, "0");
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${minutes}:${pad(rest)}`;
}

/** Tracked seconds as a total a timesheet reads: "6h 15m". */
export function formatTrackedSeconds(seconds: number | null | undefined): string {
    if (!seconds || seconds <= 0) return "0m";
    return formatDurationMinutes(Math.round(seconds / 60)) || "0m";
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const DAY_MS = 24 * 60 * 60 * 1000;

export function startOfDay(date: Date): Date {
    const copy = new Date(date);
    copy.setHours(0, 0, 0, 0);
    return copy;
}

export function endOfDay(date: Date): Date {
    const copy = new Date(date);
    copy.setHours(23, 59, 59, 999);
    return copy;
}

export function addDays(date: Date, days: number): Date {
    const copy = new Date(date);
    copy.setDate(copy.getDate() + days);
    return copy;
}

/**
 * The first day of the week a date falls in.
 *
 * Which day that is belongs to the reader, not to the engine: half the world
 * reads a week as Monday to Sunday and half as Sunday to Saturday, and a
 * calendar drawn the other way round is one nobody can plan against. Every
 * screen passes the account's choice (`weekStartIndex` off the display
 * preferences); the default is Monday, which is what the sprint and the
 * timesheet count from when nobody has said otherwise.
 *
 * @param weekStartsOn - A `Date.getDay()` index: 0 Sunday, 1 Monday, 6 Saturday.
 */
export function startOfWeek(date: Date, weekStartsOn = 1): Date {
    const copy = startOfDay(date);
    const weekday = (copy.getDay() - weekStartsOn + 7) % 7;
    return addDays(copy, -weekday);
}

export function startOfMonth(date: Date): Date {
    const copy = startOfDay(date);
    copy.setDate(1);
    return copy;
}

/** Whole days between two instants, ignoring the time of day. */
export function daysBetween(from: Date, to: Date): number {
    return Math.round((startOfDay(to).getTime() - startOfDay(from).getTime()) / DAY_MS);
}

export function isSameDay(left: Date, right: Date): boolean {
    return startOfDay(left).getTime() === startOfDay(right).getTime();
}

/** The window a relative-date token covers right now. Stored as a token rather
 *  than a date so a view saved as "due this week" stays true next week. */
export function resolveRelativeDate(
    token: work.RelativeDate,
    now: Date,
    weekStartsOn = 1
): { from: Date; to: Date } {
    const today = startOfDay(now);
    switch (token) {
        case "today":
            return { from: today, to: endOfDay(now) };
        case "tomorrow":
            return { from: addDays(today, 1), to: endOfDay(addDays(today, 1)) };
        case "yesterday":
            return { from: addDays(today, -1), to: endOfDay(addDays(today, -1)) };
        case "thisWeek": {
            const from = startOfWeek(now, weekStartsOn);
            return { from, to: endOfDay(addDays(from, 6)) };
        }
        case "nextWeek": {
            const from = addDays(startOfWeek(now, weekStartsOn), 7);
            return { from, to: endOfDay(addDays(from, 6)) };
        }
        case "lastWeek": {
            const from = addDays(startOfWeek(now, weekStartsOn), -7);
            return { from, to: endOfDay(addDays(from, 6)) };
        }
        case "thisMonth": {
            const from = startOfMonth(now);
            const to = new Date(from.getFullYear(), from.getMonth() + 1, 0, 23, 59, 59, 999);
            return { from, to };
        }
        case "nextMonth": {
            const from = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            const to = new Date(from.getFullYear(), from.getMonth() + 1, 0, 23, 59, 59, 999);
            return { from, to };
        }
        case "overdue":
            // Everything up to this instant. The lower bound is the epoch rather
            // than a guess at how old a task can be.
            return { from: new Date(0), to: now };
    }
}

// ---------------------------------------------------------------------------
// Due-date buckets
// ---------------------------------------------------------------------------

export const DUE_BUCKETS = ["overdue", "today", "tomorrow", "thisWeek", "later", "none"] as const;
export type DueBucket = (typeof DUE_BUCKETS)[number];

export const DUE_BUCKET_LABELS: Record<DueBucket, string> = {
    overdue: "Overdue",
    today: "Today",
    tomorrow: "Tomorrow",
    thisWeek: "This week",
    later: "Later",
    none: "No due date"
};

/** What counts as the deadline. A task with no time of day is due at the end of
 *  its day, so an all-day task set for today is not overdue at breakfast. */
function deadlineOf(task: Pick<TaskFacts, "dueDate" | "timed">): Date | null {
    if (!task.dueDate) return null;
    return task.timed === true ? task.dueDate : endOfDay(task.dueDate);
}

/**
 * Which pile a task belongs in on the home screen. A finished task is never
 * overdue: the date has stopped mattering once the work is done, and colouring
 * it red is how a done list ends up looking like a crisis.
 */
export function dueBucket(
    task: Pick<TaskFacts, "dueDate" | "statusType" | "timed">,
    now: Date,
    weekStartsOn = 1
): DueBucket {
    const { dueDate } = task;
    if (!dueDate) return "none";
    const deadline = deadlineOf(task) as Date;
    if (!work.isFinishedStatus(task.statusType) && deadline.getTime() < now.getTime()) return "overdue";
    if (isSameDay(dueDate, now)) return "today";
    if (isSameDay(dueDate, addDays(now, 1))) return "tomorrow";
    const weekEnd = endOfDay(addDays(startOfWeek(now, weekStartsOn), 6));
    return dueDate >= startOfDay(now) && dueDate <= weekEnd ? "thisWeek" : "later";
}

/** Whether a task is past its due date and still unfinished. */
export function isOverdue(task: Pick<TaskFacts, "dueDate" | "statusType" | "timed">, now: Date): boolean {
    return dueBucket(task, now) === "overdue";
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

/** The value a condition compares against, per field. */
function factValues(task: TaskFacts, condition: work.TaskFilterCondition): string[] {
    switch (condition.field) {
        case "status":
            return task.statusId ? [task.statusId] : [];
        case "statusType":
            return [task.statusType];
        case "assignee":
            return [...task.assigneeIds];
        case "watcher":
            return [...(task.watcherIds ?? [])];
        case "createdBy":
            return task.createdById ? [task.createdById] : [];
        case "priority":
            return [task.priority];
        case "tag":
            return [...task.tagIds];
        case "list":
            return [task.listId];
        case "name":
            return [task.name];
        case "archived":
            return [String(task.archived)];
        case "blocked":
            return [String(task.blocked ?? false)];
        case "points":
            return task.points === null ? [] : [String(task.points)];
        case "timeEstimate":
            return task.timeEstimate === null ? [] : [String(task.timeEstimate)];
        case "customField": {
            const value = condition.fieldId ? task.customValues?.[condition.fieldId] : undefined;
            return value ? [value] : [];
        }
        case "dueDate":
        case "startDate":
        case "createdAt":
            return [];
    }
}

/** The date a date-field condition is about. */
function factDate(task: TaskFacts, field: work.TaskFilterCondition["field"]): Date | null {
    if (field === "dueDate") return task.dueDate;
    if (field === "startDate") return task.startDate;
    if (field === "createdAt") return task.createdAt;
    return null;
}

const DATE_FIELDS = new Set<work.TaskFilterCondition["field"]>(["dueDate", "startDate", "createdAt"]);
const NUMBER_FIELDS = new Set<work.TaskFilterCondition["field"]>(["points", "timeEstimate"]);

/** A condition value that names a relative window, or null when it is an
 *  absolute ISO date. */
function asRelative(value: string): work.RelativeDate | null {
    const tokens: readonly string[] = [
        "today",
        "tomorrow",
        "yesterday",
        "thisWeek",
        "nextWeek",
        "lastWeek",
        "thisMonth",
        "nextMonth",
        "overdue"
    ];
    return tokens.includes(value) ? (value as work.RelativeDate) : null;
}

/** Resolve a condition value to an instant, honouring relative tokens. */
function conditionDate(
    value: string | undefined,
    now: Date,
    edge: "from" | "to",
    weekStartsOn: number
): Date | null {
    if (!value) return null;
    const relative = asRelative(value);
    if (relative) return resolveRelativeDate(relative, now, weekStartsOn)[edge];
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function matchesDateCondition(
    date: Date | null,
    condition: work.TaskFilterCondition,
    now: Date,
    weekStartsOn: number
): boolean {
    switch (condition.operator) {
        case "isSet":
            return date !== null;
        case "isNotSet":
            return date === null;
        default:
            break;
    }
    if (!date) return false;

    const first = condition.values[0];
    if (condition.operator === "between") {
        const from = conditionDate(first, now, "from", weekStartsOn);
        const to = conditionDate(condition.values[1] ?? first, now, "to", weekStartsOn);
        if (!from || !to) return false;
        return date >= from && date <= to;
    }
    if (condition.operator === "before" || condition.operator === "lt") {
        const to = conditionDate(first, now, "from", weekStartsOn);
        return to !== null && date < to;
    }
    if (condition.operator === "after" || condition.operator === "gt") {
        const from = conditionDate(first, now, "to", weekStartsOn);
        return from !== null && date > from;
    }
    // "is" on a date means "falls within that window", which is the only reading
    // that makes "due is today" behave the way a person expects.
    const from = conditionDate(first, now, "from", weekStartsOn);
    const to = conditionDate(first, now, "to", weekStartsOn);
    if (!from || !to) return false;
    const inside = date >= from && date <= to;
    return condition.operator === "isNot" ? !inside : inside;
}

function matchesNumberCondition(value: number | null, condition: work.TaskFilterCondition): boolean {
    if (condition.operator === "isSet") return value !== null;
    if (condition.operator === "isNotSet") return value === null;
    if (value === null) return false;
    const target = Number(condition.values[0]);
    if (!Number.isFinite(target)) return false;
    switch (condition.operator) {
        case "gt":
        case "after":
            return value > target;
        case "lt":
        case "before":
            return value < target;
        case "isNot":
            return value !== target;
        case "between": {
            const upper = Number(condition.values[1]);
            return Number.isFinite(upper) && value >= target && value <= upper;
        }
        default:
            return value === target;
    }
}

/** Whether one task satisfies one condition. */
export function matchesCondition(
    task: TaskFacts,
    condition: work.TaskFilterCondition,
    now: Date,
    weekStartsOn = 1
): boolean {
    if (DATE_FIELDS.has(condition.field)) {
        // "due date is overdue" is a question about the status too, so it routes
        // through the same bucket logic the home screen uses.
        if (condition.values.includes("overdue") && condition.operator === "is") {
            return isOverdue(task, now);
        }
        return matchesDateCondition(factDate(task, condition.field), condition, now, weekStartsOn);
    }
    if (NUMBER_FIELDS.has(condition.field)) {
        return matchesNumberCondition(
            condition.field === "points" ? task.points : task.timeEstimate,
            condition
        );
    }

    const values = factValues(task, condition);
    const wanted = condition.values;
    switch (condition.operator) {
        case "isSet":
            return values.length > 0;
        case "isNotSet":
            return values.length === 0;
        case "is":
            return wanted.length === 0 || values.some((value) => value === wanted[0]);
        case "isNot":
            return wanted.length === 0 || !values.some((value) => value === wanted[0]);
        case "anyOf":
            return wanted.length === 0 || values.some((value) => wanted.includes(value));
        case "noneOf":
            return wanted.length === 0 || !values.some((value) => wanted.includes(value));
        case "contains":
            return values.some((value) => value.toLowerCase().includes((wanted[0] ?? "").toLowerCase()));
        case "notContains":
            return !values.some((value) => value.toLowerCase().includes((wanted[0] ?? "").toLowerCase()));
        default:
            return true;
    }
}

/** Whether a task satisfies a whole filter. An empty filter matches everything,
 *  which is what an unfiltered view is. */
export function matchesFilter(
    task: TaskFacts,
    filter: work.TaskFilter,
    now: Date,
    weekStartsOn = 1
): boolean {
    if (filter.conditions.length === 0) return true;
    return filter.match === "all"
        ? filter.conditions.every((condition) => matchesCondition(task, condition, now, weekStartsOn))
        : filter.conditions.some((condition) => matchesCondition(task, condition, now, weekStartsOn));
}

export function applyFilter<T extends TaskFacts>(
    tasks: readonly T[],
    filter: work.TaskFilter,
    now: Date,
    weekStartsOn = 1
): T[] {
    return tasks.filter((task) => matchesFilter(task, filter, now, weekStartsOn));
}

/** Free-text search over the fields a person types into a search box. */
export function searchTasks<T extends TaskFacts & { reference?: string }>(tasks: readonly T[], query: string): T[] {
    const needle = query.trim().toLowerCase();
    if (!needle) return [...tasks];
    return tasks.filter(
        (task) =>
            task.name.toLowerCase().includes(needle) ||
            (task.reference ?? "").toLowerCase().includes(needle)
    );
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

/** Missing values sort last whichever way the column is pointed, so turning a
 *  sort around never fills the top of the screen with blanks. */
function compareNullable(left: number | null, right: number | null, direction: 1 | -1): number {
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return (left - right) * direction;
}

/**
 * How work is ordered once urgency has been decided: soonest deadline, then
 * quickest to finish, then wherever somebody put it by hand.
 *
 * That last term is what makes the result stable rather than reshuffling on
 * every render, and the two before it are the questions a person actually asks
 * of a pile of equally urgent work - when is it due, and can I clear it now.
 * Undated and unestimated tasks sink under compareNullable rather than floating
 * to the top on a missing value.
 */
function byDeadlineThenEffort(left: TaskFacts, right: TaskFacts): number {
    return (
        compareNullable(left.dueDate?.getTime() ?? null, right.dueDate?.getTime() ?? null, 1) ||
        compareNullable(left.timeEstimate, right.timeEstimate, 1) ||
        left.order - right.order
    );
}

/**
 * How two tasks that share a deadline - or have none at all - are ordered.
 *
 * A date sort leaves every undated task tied, and a pile in no order is a pile
 * nobody can work from. Urgency is what is left to go on, so the most urgent
 * comes first. Deliberately not reversed with the sort's direction: pointing a
 * date column the other way should not put the least urgent work at the top of
 * the piece of it that has no dates.
 */
function byUrgency(left: TaskFacts, right: TaskFacts): number {
    return (
        work.priorityRank(left.priority) - work.priorityRank(right.priority) ||
        byDeadlineThenEffort(left, right)
    );
}

export function compareTasks(
    left: TaskFacts,
    right: TaskFacts,
    sort: work.TaskSort,
    statusOrder?: ReadonlyMap<string, number>
): number {
    const direction: 1 | -1 = sort.direction === "desc" ? -1 : 1;
    switch (sort.field) {
        case "manual":
            return (left.order - right.order) * direction;
        case "name":
            return left.name.localeCompare(right.name) * direction;
        case "status":
            return (
                compareNullable(
                    statusOrder?.get(left.statusId ?? "") ?? null,
                    statusOrder?.get(right.statusId ?? "") ?? null,
                    direction
                ) || left.order - right.order
            );
        // The default, and the one a board opens on. Equal urgency is the common
        // case rather than the edge - most work sits on "normal" - so the tie is
        // broken by deadline and then by how long the thing takes, which is the
        // order somebody would pick the next task in anyway. Only the priority
        // term follows the sort's direction: asking for least urgent first is
        // not asking for the furthest deadline first within each band.
        case "priority":
            return (
                (work.priorityRank(left.priority) - work.priorityRank(right.priority)) * direction ||
                byDeadlineThenEffort(left, right)
            );
        case "dueDate":
            return (
                compareNullable(left.dueDate?.getTime() ?? null, right.dueDate?.getTime() ?? null, direction) ||
                byUrgency(left, right)
            );
        case "startDate":
            return compareNullable(
                left.startDate?.getTime() ?? null,
                right.startDate?.getTime() ?? null,
                direction
            );
        case "createdAt":
            return (left.createdAt.getTime() - right.createdAt.getTime()) * direction;
        case "updatedAt":
            return compareNullable(
                left.updatedAt?.getTime() ?? null,
                right.updatedAt?.getTime() ?? null,
                direction
            );
        case "points":
            return compareNullable(left.points, right.points, direction);
        case "timeEstimate":
            return compareNullable(left.timeEstimate, right.timeEstimate, direction);
    }
}

export function sortTasks<T extends TaskFacts>(
    tasks: readonly T[],
    sort: work.TaskSort,
    statusOrder?: ReadonlyMap<string, number>
): T[] {
    return [...tasks].sort((left, right) => compareTasks(left, right, sort, statusOrder));
}

// ---------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------

export interface TaskGroup<T> {
    /** The id the group is keyed by, or "" for the unset pile. */
    readonly key: string;
    readonly label: string;
    readonly color?: string;
    readonly tasks: T[];
}

/** The names and colours grouping needs, so the engine never reads a database. */
export interface GroupContext {
    readonly statuses?: readonly { id: string; name: string; color: string }[];
    readonly people?: readonly { id: string; name: string }[];
    readonly tags?: readonly { id: string; name: string; color: string }[];
    readonly lists?: readonly { id: string; name: string }[];
}

/** One column of a board grouped by status, and every status row it stands for. */
export interface StatusColumn {
    /** The status the column is keyed by: the first one that carries this name. */
    readonly id: string;
    readonly name: string;
    readonly color: string;
    /** Every status id that lands in this column, the key included. */
    readonly ids: string[];
}

/**
 * The columns a board draws for a set of statuses.
 *
 * Statuses belong to a space, so a screen that spans several - Everything, a
 * sprint drawing on two spaces - is handed one "In progress" per space. Drawn
 * literally that is the same board repeated once per space, which is not a view
 * of anything. Columns are therefore keyed by what the status is called: three
 * spaces that all call it "Done" share one Done column, and a space that calls
 * it something else keeps its own.
 *
 * Case and surrounding space do not make a new column - "In Progress" and "in
 * progress" are the same column to everyone reading the board.
 */
export function statusColumns(
    statuses: readonly { id: string; name: string; color: string }[]
): StatusColumn[] {
    const columns: StatusColumn[] = [];
    const byName = new Map<string, StatusColumn>();
    for (const status of statuses) {
        const key = status.name.trim().toLowerCase();
        const existing = byName.get(key);
        if (existing) {
            existing.ids.push(status.id);
            continue;
        }
        const column: StatusColumn = { id: status.id, name: status.name, color: status.color, ids: [status.id] };
        byName.set(key, column);
        columns.push(column);
    }
    return columns;
}

/**
 * Where each status sorts, by the column it belongs to rather than by its own
 * position. Two spaces that both end in "Done" must not interleave their rows
 * just because one of them defined it fourth and the other fifth.
 */
export function statusColumnOrder(
    statuses: readonly { id: string; name: string; color: string }[]
): Map<string, number> {
    const order = new Map<string, number>();
    statusColumns(statuses).forEach((column, index) => {
        for (const id of column.ids) order.set(id, index);
    });
    return order;
}

/** The pile something unset lands in. Always last, always present when it has
 *  members, so a board never hides a task by having no column for it. */
const UNSET_LABELS: Partial<Record<work.TaskGroupField, string>> = {
    status: "No status",
    assignee: "Unassigned",
    tag: "No tag",
    list: "No list"
};

/**
 * Split tasks into the groups a view draws as columns or headers. Empty groups
 * are kept for status, priority and blocked (a board needs its columns even
 * before any work reaches them, and "nothing is blocked" is worth seeing) and
 * dropped for the rest, where an empty header is noise.
 */
export function groupTasks<T extends TaskFacts>(
    tasks: readonly T[],
    groupBy: work.TaskGroupField,
    context: GroupContext = {},
    now: Date = new Date(),
    weekStartsOn = 1
): TaskGroup<T>[] {
    if (groupBy === "none") return [{ key: "", label: "All tasks", tasks: [...tasks] }];

    const buckets = new Map<string, T[]>();
    const push = (key: string, task: T) => {
        const existing = buckets.get(key);
        if (existing) existing.push(task);
        else buckets.set(key, [task]);
    };

    // Statuses are collapsed to columns before anything is bucketed rather than
    // afterwards, so a column that several spaces feed keeps the one order the
    // tasks arrived in instead of one space's tasks followed by the next's.
    const columns = groupBy === "status" ? statusColumns(context.statuses ?? []) : [];
    const columnOf = new Map<string, string>();
    for (const column of columns) for (const id of column.ids) columnOf.set(id, column.id);

    for (const task of tasks) {
        switch (groupBy) {
            case "status":
                push(task.statusId ? (columnOf.get(task.statusId) ?? task.statusId) : "", task);
                break;
            case "priority":
                push(task.priority, task);
                break;
            case "dueDate":
                push(dueBucket(task, now, weekStartsOn), task);
                break;
            case "list":
                push(task.listId, task);
                break;
            case "assignee":
                if (task.assigneeIds.length === 0) push("", task);
                // A task with two assignees appears under both, which is what a
                // person looking for "my work" expects to see.
                else for (const id of task.assigneeIds) push(id, task);
                break;
            case "tag":
                if (task.tagIds.length === 0) push("", task);
                else for (const id of task.tagIds) push(id, task);
                break;
            case "blocked":
                push(task.blocked ? "blocked" : "clear", task);
                break;
        }
    }

    const groups: TaskGroup<T>[] = [];
    const take = (key: string) => buckets.get(key) ?? [];
    const consume = (key: string) => {
        const found = take(key);
        buckets.delete(key);
        return found;
    };

    if (groupBy === "status") {
        for (const column of columns) {
            groups.push({ key: column.id, label: column.name, color: column.color, tasks: consume(column.id) });
        }
    } else if (groupBy === "priority") {
        for (const priority of ["urgent", "high", "normal", "low", "none"] as const) {
            groups.push({
                key: priority,
                label: priority === "none" ? "No priority" : priority[0]!.toUpperCase() + priority.slice(1),
                tasks: consume(priority)
            });
        }
    } else if (groupBy === "dueDate") {
        for (const bucket of DUE_BUCKETS) {
            const found = consume(bucket);
            if (found.length > 0) groups.push({ key: bucket, label: DUE_BUCKET_LABELS[bucket], tasks: found });
        }
    } else if (groupBy === "blocked") {
        // Both columns always, even when one is empty: an empty Blocked column is
        // the answer somebody grouped this way to see.
        groups.push({ key: "blocked", label: "Blocked", color: "#ef4444", tasks: consume("blocked") });
        groups.push({ key: "clear", label: "Not blocked", tasks: consume("clear") });
    } else {
        const source =
            groupBy === "assignee"
                ? (context.people ?? []).map((person) => ({ id: person.id, name: person.name, color: undefined }))
                : groupBy === "tag"
                  ? (context.tags ?? []).map((tag) => ({ id: tag.id, name: tag.name, color: tag.color }))
                  : (context.lists ?? []).map((list) => ({ id: list.id, name: list.name, color: undefined }));
        for (const entry of source) {
            const found = consume(entry.id);
            if (found.length > 0) groups.push({ key: entry.id, label: entry.name, color: entry.color, tasks: found });
        }
    }

    // Anything the context did not name (a status deleted mid-session, a person
    // no longer on the space) still has to appear, or its tasks vanish.
    for (const [key, found] of buckets) {
        if (found.length === 0) continue;
        groups.push({ key, label: key === "" ? (UNSET_LABELS[groupBy] ?? "Other") : "Other", tasks: found });
    }
    return groups;
}

// ---------------------------------------------------------------------------
// Rollups
// ---------------------------------------------------------------------------

export interface ProgressRollup {
    readonly total: number;
    readonly done: number;
    readonly percent: number;
}

/** How far a list, a sprint or a parent task has got. Closed work counts as
 *  resolved: a cancelled task is not outstanding. */
export function rollupProgress(tasks: readonly Pick<TaskFacts, "statusType">[]): ProgressRollup {
    const total = tasks.length;
    const done = tasks.filter((task) => work.isFinishedStatus(task.statusType)).length;
    return { total, done, percent: total === 0 ? 0 : Math.round((done / total) * 100) };
}

export interface EffortRollup {
    /** Minutes. */
    readonly estimate: number;
    /** Seconds. */
    readonly tracked: number;
    readonly points: number;
    /** Tracked against estimate, as a percentage. Null when nothing is estimated. */
    readonly usedPercent: number | null;
}

export function rollupEffort(
    tasks: readonly (Pick<TaskFacts, "timeEstimate" | "points"> & { trackedSeconds?: number })[]
): EffortRollup {
    let estimate = 0;
    let tracked = 0;
    let points = 0;
    for (const task of tasks) {
        estimate += task.timeEstimate ?? 0;
        tracked += task.trackedSeconds ?? 0;
        points += task.points ?? 0;
    }
    return {
        estimate,
        tracked,
        points,
        usedPercent: estimate > 0 ? Math.round((tracked / 60 / estimate) * 100) : null
    };
}

// ---------------------------------------------------------------------------
// Subtask trees
// ---------------------------------------------------------------------------

export interface TaskNode<T> {
    readonly task: T;
    readonly depth: number;
    readonly children: TaskNode<T>[];
}

/**
 * Nest a flat list by parent. A task whose parent is not in the set is treated
 * as a root, so filtering to "my tasks" shows the subtask assigned to you rather
 * than dropping it because its parent belongs to somebody else.
 */
export function buildTaskTree<T extends TaskFacts>(tasks: readonly T[], maxDepth = 7): TaskNode<T>[] {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const children = new Map<string, T[]>();
    const roots: T[] = [];
    for (const task of tasks) {
        if (task.parentId && byId.has(task.parentId)) {
            const siblings = children.get(task.parentId);
            if (siblings) siblings.push(task);
            else children.set(task.parentId, [task]);
        } else {
            roots.push(task);
        }
    }
    const build = (task: T, depth: number): TaskNode<T> => ({
        task,
        depth,
        children:
            depth >= maxDepth ? [] : (children.get(task.id) ?? []).map((child) => build(child, depth + 1))
    });
    return roots.map((task) => build(task, 0));
}

/** A tree flattened back to rows, honouring which parents are collapsed. */
export function flattenTree<T extends TaskFacts>(
    nodes: readonly TaskNode<T>[],
    collapsed: ReadonlySet<string> = new Set()
): TaskNode<T>[] {
    const rows: TaskNode<T>[] = [];
    const walk = (node: TaskNode<T>) => {
        rows.push(node);
        if (!collapsed.has(node.task.id)) node.children.forEach(walk);
    };
    nodes.forEach(walk);
    return rows;
}

// ---------------------------------------------------------------------------
// Folder trees
// ---------------------------------------------------------------------------

/** The little a folder has to expose for the tree maths to work on it. */
export interface FolderRow {
    readonly id: string;
    readonly parentId: string | null;
}

export interface FolderNode<T extends FolderRow> {
    readonly folder: T;
    readonly depth: number;
    readonly children: FolderNode<T>[];
}

/**
 * Nest folders by parent. A folder whose parent is missing from the set becomes
 * a root, which is what keeps a pruned tree (somebody invited to one client, not
 * the whole space) drawable without inventing the ancestors they cannot see.
 */
export function buildFolderTree<T extends FolderRow>(
    folders: readonly T[],
    maxDepth = work.FOLDER_DEPTH_LIMIT
): FolderNode<T>[] {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const children = new Map<string, T[]>();
    const roots: T[] = [];
    for (const folder of folders) {
        if (folder.parentId && byId.has(folder.parentId)) {
            const siblings = children.get(folder.parentId);
            if (siblings) siblings.push(folder);
            else children.set(folder.parentId, [folder]);
        } else {
            roots.push(folder);
        }
    }
    const build = (folder: T, depth: number): FolderNode<T> => ({
        folder,
        depth,
        children:
            depth + 1 >= maxDepth
                ? []
                : (children.get(folder.id) ?? []).map((child) => build(child, depth + 1))
    });
    return roots.map((folder) => build(folder, 0));
}

/** The chain from the root down to this folder, itself last. Bounded by the
 *  depth limit so a row that somehow points at its own ancestor cannot spin. */
export function folderAncestors<T extends FolderRow>(folders: readonly T[], folderId: string): T[] {
    const byId = new Map(folders.map((folder) => [folder.id, folder]));
    const chain: T[] = [];
    let current = byId.get(folderId);
    for (let depth = 0; depth < work.FOLDER_DEPTH_LIMIT && current; depth += 1) {
        chain.unshift(current);
        current = current.parentId ? byId.get(current.parentId) : undefined;
    }
    return chain;
}

/** A folder and everything under it. The folder itself is included, because
 *  every caller either moves it or checks access to the whole branch. */
export function folderBranch<T extends FolderRow>(folders: readonly T[], folderId: string): Set<string> {
    const children = new Map<string, string[]>();
    for (const folder of folders) {
        if (!folder.parentId) continue;
        const siblings = children.get(folder.parentId);
        if (siblings) siblings.push(folder.id);
        else children.set(folder.parentId, [folder.id]);
    }
    const branch = new Set<string>();
    const stack = [folderId];
    while (stack.length > 0) {
        const current = stack.pop() as string;
        if (branch.has(current)) continue;
        branch.add(current);
        for (const child of children.get(current) ?? []) stack.push(child);
    }
    return branch;
}

/** How deep this folder sits, counting the root as zero. */
export function folderDepth<T extends FolderRow>(folders: readonly T[], folderId: string): number {
    return Math.max(0, folderAncestors(folders, folderId).length - 1);
}

/**
 * Why a folder cannot be dropped where it was dropped, or null when it can.
 *
 * Two things go wrong on a drag: dropping a folder inside its own branch, which
 * detaches the whole subtree from the tree and loses it; and dropping a deep
 * branch under an already-deep parent, which pushes descendants past the depth
 * the sidebar and the breadcrumb can render. Both are refused with a sentence a
 * person can act on rather than a silent no-op.
 */
export function folderMoveRefusal<T extends FolderRow>(
    folders: readonly T[],
    folderId: string,
    parentId: string | null
): string | null {
    if (parentId === null) return null;
    if (parentId === folderId) return "A folder cannot be moved into itself";
    const branch = folderBranch(folders, folderId);
    if (branch.has(parentId)) return "A folder cannot be moved into one of its own subfolders";

    // The deepest descendant decides: moving a two-level branch under a parent
    // at depth 6 would put its leaves at 8.
    const own = folderDepth(folders, folderId);
    const deepest = [...branch].reduce((max, id) => Math.max(max, folderDepth(folders, id)), own);
    const height = deepest - own;
    if (folderDepth(folders, parentId) + 1 + height >= work.FOLDER_DEPTH_LIMIT) {
        return `Folders can nest ${work.FOLDER_DEPTH_LIMIT} deep, and that would go further`;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export interface DependencyEdge {
    /** The task that must finish first. */
    readonly blockerId: string;
    /** The task held up by it. */
    readonly blockedId: string;
}

/**
 * Whether adding an edge would close a loop. A cycle in "blocks" makes a gantt
 * chart unsolvable and a scheduler spin, so it is refused at the point of entry
 * rather than detected later.
 */
export function wouldCycle(edges: readonly DependencyEdge[], blockerId: string, blockedId: string): boolean {
    if (blockerId === blockedId) return true;
    const forward = new Map<string, string[]>();
    for (const edge of edges) {
        const existing = forward.get(edge.blockerId);
        if (existing) existing.push(edge.blockedId);
        else forward.set(edge.blockerId, [edge.blockedId]);
    }
    // Reachable from the task being blocked: if the blocker is in there, the new
    // edge points back into its own downstream.
    const seen = new Set<string>();
    const stack = [blockedId];
    while (stack.length > 0) {
        const current = stack.pop() as string;
        if (current === blockerId) return true;
        if (seen.has(current)) continue;
        seen.add(current);
        for (const next of forward.get(current) ?? []) stack.push(next);
    }
    return false;
}

/** The ids of tasks that cannot start yet because something unfinished blocks
 *  them. Used to mark a card rather than to prevent the move: people override
 *  their own process, and a warning respects that while a block does not. */
export function blockedTaskIds(
    edges: readonly DependencyEdge[],
    statusById: ReadonlyMap<string, work.TaskStatusType>
): Set<string> {
    const blocked = new Set<string>();
    for (const edge of edges) {
        const blockerStatus = statusById.get(edge.blockerId);
        if (blockerStatus && !work.isFinishedStatus(blockerStatus)) blocked.add(edge.blockedId);
    }
    return blocked;
}

// ---------------------------------------------------------------------------
// work.Recurrence
// ---------------------------------------------------------------------------

/** Clamp a day-of-month to a month that is shorter than it. The 31st of a
 *  30-day month is the 30th, which is what a monthly bill on the 31st means. */
function withDayOfMonth(date: Date, day: number): Date {
    const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
    const copy = new Date(date);
    copy.setDate(Math.min(day, lastDay));
    return copy;
}

/**
 * When a recurring task should next fall due.
 *
 * `from` is the anchor the rule counts from: the previous due date for a
 * schedule-based rule, the completion instant for a completion-based one. The
 * caller picks which, because only the caller knows why it is asking.
 *
 * Returns null once the rule has run out (past its end date), so the caller
 * stops regenerating instead of looping forever.
 */
export function nextOccurrence(recurrence: work.Recurrence, from: Date, occurrencesSoFar = 0): Date | null {
    if (recurrence.endsAfter !== undefined && occurrencesSoFar >= recurrence.endsAfter) return null;

    const interval = Math.max(1, recurrence.interval);
    let next: Date;
    switch (recurrence.mode) {
        case "daily":
            next = addDays(from, interval);
            break;
        case "weekly": {
            const weekdays = [...recurrence.weekdays].sort((left, right) => left - right);
            if (weekdays.length === 0) {
                next = addDays(from, 7 * interval);
                break;
            }
            // The next chosen weekday later this week, else the first chosen
            // weekday of the week `interval` weeks on.
            const current = from.getDay();
            const upcoming = weekdays.find((day) => day > current);
            next =
                upcoming !== undefined
                    ? addDays(from, upcoming - current)
                    : addDays(startOfWeek(from), 7 * interval + ((weekdays[0]! + 6) % 7));
            break;
        }
        case "monthly": {
            const target = new Date(from);
            target.setDate(1);
            target.setMonth(target.getMonth() + interval);
            next = withDayOfMonth(target, recurrence.dayOfMonth ?? from.getDate());
            break;
        }
        case "yearly": {
            const target = new Date(from);
            target.setDate(1);
            target.setFullYear(target.getFullYear() + interval);
            if (recurrence.month !== undefined) target.setMonth(recurrence.month);
            next = withDayOfMonth(target, recurrence.dayOfMonth ?? from.getDate());
            break;
        }
    }

    // Keep the time of day of the original due date: a stand-up that recurs is
    // still at 09:30.
    next.setHours(from.getHours(), from.getMinutes(), from.getSeconds(), 0);

    if (recurrence.endsOn) {
        const endsOn = new Date(recurrence.endsOn);
        if (!Number.isNaN(endsOn.getTime()) && next > endsOn) return null;
    }
    return next;
}

// ---------------------------------------------------------------------------
// Automations
// ---------------------------------------------------------------------------

/** What happened, as the rule engine is told about it. */
export interface AutomationEvent {
    readonly trigger: work.AutomationTrigger;
    readonly task: TaskFacts;
    /** The list the task was in before a move, for `task.moved`. */
    readonly previousListId?: string;
    /** The status it held before a change, so a rule can react to a transition. */
    readonly previousStatusId?: string;
}

export interface AutomationRule {
    readonly id: string;
    readonly trigger: work.AutomationTrigger;
    readonly conditions: work.TaskFilter;
    readonly enabled: boolean;
    /** Null means the rule covers the whole space. */
    readonly listId: string | null;
}

/**
 * Which rules should run for an event, in the order they were defined. A
 * disabled rule, a rule for another trigger, and a rule whose conditions the
 * task does not meet are all simply not selected - the engine never partially
 * applies a rule.
 */
export function selectAutomations(
    rules: readonly AutomationRule[],
    event: AutomationEvent,
    now: Date
): AutomationRule[] {
    return rules.filter(
        (rule) =>
            rule.enabled &&
            rule.trigger === event.trigger &&
            (rule.listId === null || rule.listId === event.task.listId) &&
            matchesFilter(event.task, rule.conditions, now)
    );
}

// ---------------------------------------------------------------------------
// Gantt
// ---------------------------------------------------------------------------

export interface GanttBar {
    readonly taskId: string;
    readonly start: Date;
    readonly end: Date;
    /** Percentage offsets into the chart window, ready for a style attribute. */
    readonly offsetPercent: number;
    readonly widthPercent: number;
}

/**
 * The window a chart should cover: the earliest start to the latest due, padded
 * so bars never touch the edges, and never narrower than two weeks so a chart
 * with one task in it is still a chart.
 */
export function ganttRange(
    tasks: readonly Pick<TaskFacts, "startDate" | "dueDate">[],
    now: Date,
    weekStartsOn = 1
): { from: Date; to: Date } {
    let from: Date | null = null;
    let to: Date | null = null;
    for (const task of tasks) {
        const start = task.startDate ?? task.dueDate;
        const end = task.dueDate ?? task.startDate;
        if (start && (!from || start < from)) from = start;
        if (end && (!to || end > to)) to = end;
    }
    const anchor = startOfWeek(from ?? now, weekStartsOn);
    const finish = endOfDay(to ?? addDays(anchor, 13));
    const padded = addDays(anchor, -2);
    const minimumEnd = addDays(padded, 14);
    return { from: padded, to: finish > minimumEnd ? addDays(finish, 2) : minimumEnd };
}

/**
 * Place each task in the window. A task with only one date gets a one-day bar,
 * because a milestone still has to be visible; a task with neither is left out
 * rather than being drawn at an invented position.
 */
export function ganttBars(
    tasks: readonly Pick<TaskFacts, "id" | "startDate" | "dueDate">[],
    range: { from: Date; to: Date }
): GanttBar[] {
    const span = range.to.getTime() - range.from.getTime();
    if (span <= 0) return [];
    const bars: GanttBar[] = [];
    for (const task of tasks) {
        const start = task.startDate ?? task.dueDate;
        const end = task.dueDate ?? task.startDate;
        if (!start || !end) continue;
        const from = startOfDay(start < end ? start : end);
        const to = endOfDay(end > start ? end : start);
        const offset = ((from.getTime() - range.from.getTime()) / span) * 100;
        const width = ((to.getTime() - from.getTime()) / span) * 100;
        bars.push({
            taskId: task.id,
            start: from,
            end: to,
            offsetPercent: Math.max(0, Math.min(100, offset)),
            widthPercent: Math.max(0.6, Math.min(100 - Math.max(0, offset), width))
        });
    }
    return bars;
}

// ---------------------------------------------------------------------------
// Sprint burndown
// ---------------------------------------------------------------------------

export interface BurndownPoint {
    readonly date: Date;
    /** What should be left if the sprint burns evenly. */
    readonly ideal: number;
    /** What is actually left. Null for days in the future, so the line stops at
     *  today instead of dropping to zero. */
    readonly remaining: number | null;
}

/**
 * Points (or task count, when nothing is pointed) still open on each day of a
 * sprint. Days after `now` carry no actual value: drawing them as zero is the
 * classic burndown lie that makes an unfinished sprint look finished.
 */
export function burndown(
    input: {
        readonly start: Date;
        readonly end: Date;
        readonly tasks: readonly Pick<TaskFacts, "points" | "completedAt" | "statusType">[];
    },
    now: Date
): BurndownPoint[] {
    const usePoints = input.tasks.some((task) => (task.points ?? 0) > 0);
    const weight = (task: Pick<TaskFacts, "points">) => (usePoints ? (task.points ?? 0) : 1);
    const total = input.tasks.reduce((sum, task) => sum + weight(task), 0);

    const days = Math.max(1, daysBetween(input.start, input.end));
    const points: BurndownPoint[] = [];
    for (let index = 0; index <= days; index += 1) {
        const date = endOfDay(addDays(startOfDay(input.start), index));
        const ideal = Math.max(0, total - (total / days) * index);
        if (startOfDay(date) > startOfDay(now)) {
            points.push({ date, ideal, remaining: null });
            continue;
        }
        const burned = input.tasks.reduce(
            (sum, task) => (task.completedAt && task.completedAt <= date ? sum + weight(task) : sum),
            0
        );
        points.push({ date, ideal, remaining: Math.max(0, total - burned) });
    }
    return points;
}

// ---------------------------------------------------------------------------
// Human-readable identifiers
// ---------------------------------------------------------------------------

/**
 * A space's short prefix, derived from its name: "Product Design" becomes "PD",
 * "Engineering" becomes "ENG". People quote these in commits and chat, so they
 * are stable once assigned and never regenerated from a renamed space.
 */
export function deriveSpacePrefix(name: string): string {
    const words = name
        .toUpperCase()
        .replace(/[^A-Z0-9\s]/g, " ")
        .split(/\s+/)
        .filter(Boolean);
    if (words.length === 0) return "TASK";
    if (words.length === 1) return words[0]!.slice(0, 4);
    return words
        .slice(0, 3)
        .map((word) => word[0])
        .join("");
}

/** The reference a person quotes: "ENG-42". */
export function taskReference(prefix: string, number: number): string {
    return `${prefix}-${number}`;
}
