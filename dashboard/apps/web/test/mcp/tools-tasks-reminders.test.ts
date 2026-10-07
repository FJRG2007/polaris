/**
 * Due dates, names and reminders in the task tools.
 *
 * What is pinned is what a model's words become: a day or a time is read on the
 * person's own clock, not the server's; a task is found by its exact name but
 * two of one name are named back rather than guessed between; and a reminder is
 * the caller's own - set ahead of now, and cancelled only by whoever set it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    visibleScope: vi.fn(),
    listTasks: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    requireList: vi.fn(),
    requireTask: vi.fn(),
    listFindFirst: vi.fn(),
    taskFindMany: vi.fn(),
    reminderFindMany: vi.fn(),
    reminderFindFirst: vi.fn(),
    addReminder: vi.fn(),
    deleteReminder: vi.fn()
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        task: {
            findFirst: async () => ({ id: TASK_1, spaceId: "space-1" }),
            findMany: mocks.taskFindMany
        },
        taskList: { findFirst: mocks.listFindFirst },
        taskReminder: { findMany: mocks.reminderFindMany, findFirst: mocks.reminderFindFirst }
    }
}));
// The rest of the catalogue loads with these tools; its operations are not under test here.
vi.mock("@/lib/deploy/api/surface", () => ({}));
vi.mock("@/lib/display-prefs-service", () => ({
    resolveDisplayPreferencesFor: async () => ({ timeZone: "Europe/Madrid" })
}));
vi.mock("@/lib/tasks/access", () => ({
    visibleScope: mocks.visibleScope,
    scopeSpaceIds: () => ["space-1"],
    scopeTaskWhere: () => ({ reachable: true }),
    requireList: mocks.requireList,
    requireTask: mocks.requireTask
}));
vi.mock("@/lib/tasks/task-service", () => ({
    listTasks: mocks.listTasks,
    createTask: mocks.createTask,
    updateTask: mocks.updateTask
}));
vi.mock("@/lib/tasks/task-detail-service", () => ({
    addComment: vi.fn(),
    addReminder: mocks.addReminder,
    deleteReminder: mocks.deleteReminder
}));

const { MCP_TOOLS } = await import("@/lib/mcp/tools");
const { handleMcpMessage } = await import("@/lib/mcp/protocol");

const SERVER = { name: "polaris", version: "1", instructions: "" };
const REMINDER = "66666666-6666-4666-8666-666666666666";
const TASK_1 = "00000000-0000-4000-8000-000000000001";
const LIST = "77777777-7777-4777-8777-777777777777";

type ToolResult = { content: { text: string }[]; isError?: boolean; structuredContent?: any };

async function call(
    name: string,
    args: Record<string, unknown>,
    scopes: string[] = ["tasks.read", "tasks.manage"]
) {
    const reply = await handleMcpMessage(
        { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
        MCP_TOOLS,
        { userId: "user-1", isAdmin: false, scopes: scopes as never },
        SERVER
    );
    return (reply?.result ?? reply?.error) as ToolResult & { message?: string };
}

function row(number: number, name: string) {
    return {
        id: `00000000-0000-4000-8000-00000000000${number}`,
        number,
        name,
        spaceId: "space-1",
        space: { prefix: "ENG" }
    };
}

const NAMED = [
    row(1, "Send the October invoices"),
    row(2, "Renew the domain"),
    row(3, "Renew the domain")
];

beforeEach(() => {
    vi.clearAllMocks();
    mocks.visibleScope.mockResolvedValue({ listIds: [] });
    mocks.listTasks.mockResolvedValue([]);
    mocks.taskFindMany.mockImplementation(async ({ where }) => {
        const exact = where.AND[1]?.name?.equals as string | undefined;
        return exact === undefined
            ? NAMED
            : NAMED.filter((task) => task.name.toLowerCase() === exact.toLowerCase());
    });
    mocks.listFindFirst.mockResolvedValue({ id: LIST, spaceId: "space-1" });
    mocks.createTask.mockResolvedValue({ id: "task-9", reference: "ENG-9" });
});

describe("due dates", () => {
    it("read a day as the start of it on the person's clock, and a time as that time", async () => {
        await call("tasks_create", { list: "Backlog", name: "Pay rent", due: "2026-11-01" });
        expect(mocks.createTask.mock.calls[0]![2]).toMatchObject({
            dueDate: "2026-10-31T23:00:00.000Z",
            timed: false
        });
        await call("tasks_update", { task: "ENG-1", due: "2026-10-10T09:30" });
        expect(mocks.updateTask.mock.calls[0]![1]).toMatchObject({
            dueDate: "2026-10-10T07:30:00.000Z",
            timed: true
        });
    });

    it("clear one with an empty string, and refuse a day the calendar does not have", async () => {
        await call("tasks_update", { task: "ENG-1", due: "" });
        expect(mocks.updateTask.mock.calls[0]![1]).toMatchObject({ dueDate: null, timed: false });
        const nonsense = await call("tasks_update", { task: "ENG-1", due: "2026-02-30" });
        expect(nonsense.content[0]?.text).toBe("There is no day 2026-02-30.");
        expect(mocks.updateTask).toHaveBeenCalledTimes(1);
    });
});

describe("a task by its name", () => {
    it("is found when exactly one has it, case and accents aside", async () => {
        await call("tasks_update", { task: "send the october INVOICES", priority: "high" });
        expect(mocks.updateTask.mock.calls[0]![1]).toMatchObject({
            taskId: TASK_1,
            priority: "high"
        });
    });

    it("is looked up in the database rather than in the first page of every task", async () => {
        await call("tasks_update", { task: "Send the October invoices", priority: "high" });
        expect(mocks.listTasks).not.toHaveBeenCalled();
        expect(mocks.taskFindMany).toHaveBeenCalledTimes(1);
        expect(mocks.taskFindMany.mock.calls[0]![0].where).toEqual({
            AND: [
                { AND: [{ reachable: true }, { archived: false }] },
                { name: { equals: "Send the October invoices", mode: "insensitive" } }
            ]
        });
    });

    it("offers the closest for a miss, and acts on none of them", async () => {
        const result = await call("tasks_update", { task: "Renew domain", priority: "high" });
        expect(result.content[0]?.text).toContain('No task is called "Renew domain"');
        expect(result.content[0]?.text).toContain("ENG-2 Renew the domain");
        expect(mocks.updateTask).not.toHaveBeenCalled();
    });

    it("is named back with references when two share it, and nothing changes", async () => {
        const result = await call("tasks_update", { task: "Renew the domain", priority: "high" });
        expect(result.content[0]?.text).toContain("More than one task");
        expect(result.content[0]?.text).toContain("ENG-2");
        expect(result.content[0]?.text).toContain("ENG-3");
        expect(mocks.updateTask).not.toHaveBeenCalled();
    });
});

describe("reminders", () => {
    it("are set on the person's clock, for the caller", async () => {
        vi.useFakeTimers({ now: new Date("2026-10-07T12:00:00Z"), toFake: ["Date"] });
        try {
            const result = await call("tasks_remind", {
                task: "ENG-1",
                at: "2026-10-08T09:00",
                note: "Chase the bank"
            });
            expect(result.isError).toBeUndefined();
            expect(result.content[0]?.text).toBe("Reminder set for Thu, 8 Oct 2026, 09:00.");
            expect(result.structuredContent.at).toBe("2026-10-08T07:00:00.000Z");
            expect(mocks.requireTask).toHaveBeenCalledWith(
                { id: "user-1", isAdmin: false },
                TASK_1,
                "guest"
            );
            expect(mocks.addReminder).toHaveBeenCalledWith(
                "user-1",
                TASK_1,
                "2026-10-08T07:00:00.000Z",
                "Chase the bank"
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("are not set by a connection approved only to read", async () => {
        const result = await call("tasks_remind", { task: "ENG-1", at: "2030-01-01T09:00" }, [
            "tasks.read"
        ]);
        expect(result.content[0]?.text).toContain("tasks.manage");
        expect(mocks.addReminder).not.toHaveBeenCalled();
    });

    it("are refused for a time already gone, or a day without a time", async () => {
        const past = await call("tasks_remind", { task: "ENG-1", at: "2020-01-01T09:00" });
        expect(past.content[0]?.text).toContain("already passed");
        const dayOnly = await call("tasks_remind", { task: "ENG-1", at: "2030-01-01" });
        expect(dayOnly.content[0]?.text).toContain("time as well as a day");
        expect(mocks.addReminder).not.toHaveBeenCalled();
    });

    it("are listed for the caller only, on tasks it still reaches", async () => {
        mocks.reminderFindMany.mockResolvedValue([
            {
                id: REMINDER,
                remindAt: new Date("2026-10-08T07:00:00Z"),
                note: "",
                task: { number: 1, name: "Send the October invoices", space: { prefix: "ENG" } }
            }
        ]);
        const result = await call("tasks_reminders", {});
        expect(result.content[0]?.text).toContain("Thu, 8 Oct 2026, 09:00  ENG-1");
        expect(mocks.reminderFindMany.mock.calls[0]![0].where).toEqual({
            userId: "user-1",
            sentAt: null,
            task: { reachable: true }
        });
        expect(result.structuredContent.reminders).toEqual([
            {
                id: REMINDER,
                at: "2026-10-08T07:00:00.000Z",
                note: "",
                task: "ENG-1",
                taskName: "Send the October invoices"
            }
        ]);
    });

    it("are cancelled only by whoever set them", async () => {
        mocks.reminderFindFirst.mockResolvedValue(null);
        const other = await call("tasks_reminder_cancel", { reminder: REMINDER });
        expect(other.content[0]?.text).toBe("This account has no reminder with that id.");
        expect(mocks.reminderFindFirst).toHaveBeenCalledWith({
            where: { id: REMINDER, userId: "user-1" },
            select: { id: true }
        });
        mocks.reminderFindFirst.mockResolvedValue({ id: REMINDER });
        await call("tasks_reminder_cancel", { reminder: REMINDER });
        expect(mocks.deleteReminder).toHaveBeenCalledWith("user-1", REMINDER);
    });
});
