/**
 * A write about something inside a space or a task has to say which one.
 *
 * The actions clear the caller against a space or a task they name, then hand
 * the service the id of a row under it - a rule, a form, a sprint, a checklist,
 * a step, a link, a time entry. An id says nothing about where the row lives, so
 * a write keyed on it alone lets anybody who administers a space of their own
 * (anyone can make one) rewrite or delete that kind of row in every other space.
 * Each write here is asserted to carry its parent, and to refuse rather than do
 * nothing quietly when the row is not under it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const model = () => ({
    update: vi.fn(),
    updateMany: vi.fn(),
    deleteMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    count: vi.fn()
});

const taskAutomation = model();
const taskForm = model();
const taskList = model();
const taskSprint = model();
const task = model();
const taskTimeEntry = model();
const taskChecklist = model();
const taskChecklistItem = model();
const taskDependency = model();
const all = [
    taskAutomation,
    taskForm,
    taskList,
    taskSprint,
    task,
    taskTimeEntry,
    taskChecklist,
    taskChecklistItem,
    taskDependency
];

vi.mock("@polaris/db", () => ({
    prisma: {
        taskAutomation,
        taskForm,
        taskList,
        taskSprint,
        task,
        taskTimeEntry,
        taskChecklist,
        taskChecklistItem,
        taskDependency,
        $transaction: async (operations: unknown[]) => Promise.all(operations)
    }
}));

const automations = await import("@/lib/tasks/automation-service");
const forms = await import("@/lib/tasks/form-service");
const planning = await import("@/lib/tasks/planning-service");
const time = await import("@/lib/tasks/time-service");
const details = await import("@/lib/tasks/task-detail-service");

const SPACE = "space-1";
const TASK = "task-1";

beforeEach(() => {
    for (const row of all) {
        for (const method of Object.values(row)) method.mockReset();
        row.updateMany.mockResolvedValue({ count: 1 });
        row.deleteMany.mockResolvedValue({ count: 1 });
        row.count.mockResolvedValue(1);
        row.findFirst.mockResolvedValue({ id: "row" });
        row.create.mockResolvedValue({ id: "row" });
    }
});

const rule = {
    listId: null,
    name: "Tidy",
    trigger: "task.created",
    conditions: [],
    actions: [],
    enabled: true
} as unknown as Parameters<typeof automations.updateAutomation>[2];

const form = {
    listId: "list-1",
    name: "Intake",
    intro: "",
    fields: [],
    defaultStatusId: null,
    confirmation: "Thanks",
    requireLogin: false,
    enabled: true
} as unknown as Parameters<typeof forms.updateForm>[2];

describe("an automation", () => {
    it("is changed, switched and removed only inside the authorized space", async () => {
        await automations.updateAutomation(SPACE, "a1", rule);
        await automations.setAutomationEnabled(SPACE, "a1", false);
        await automations.deleteAutomation(SPACE, "a1");
        expect(taskAutomation.updateMany.mock.calls.every(([args]) => args.where.spaceId === SPACE)).toBe(true);
        expect(taskAutomation.deleteMany).toHaveBeenCalledWith({ where: { id: "a1", spaceId: SPACE } });
    });

    it("refuses a rule from another space", async () => {
        taskAutomation.updateMany.mockResolvedValue({ count: 0 });
        taskAutomation.deleteMany.mockResolvedValue({ count: 0 });
        await expect(automations.updateAutomation(SPACE, "elsewhere", rule)).rejects.toThrow(/not in this space/);
        await expect(automations.deleteAutomation(SPACE, "elsewhere")).rejects.toThrow(/not in this space/);
    });
});

describe("a form", () => {
    it("is kept to its space, and files only into one of that space's lists", async () => {
        await forms.updateForm(SPACE, "f1", form);
        expect(taskList.count).toHaveBeenCalledWith({ where: { id: "list-1", spaceId: SPACE } });
        expect(taskForm.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "f1", spaceId: SPACE } }));

        await forms.deleteForm(SPACE, "f1");
        expect(taskForm.deleteMany).toHaveBeenCalledWith({ where: { id: "f1", spaceId: SPACE } });
    });

    it("refuses a list from another space, on create and on edit", async () => {
        taskList.count.mockResolvedValue(0);
        await expect(forms.createForm(SPACE, "u1", form)).rejects.toThrow(/not in this space/);
        await expect(forms.updateForm(SPACE, "f1", form)).rejects.toThrow(/not in this space/);
        expect(taskForm.create).not.toHaveBeenCalled();
        expect(taskForm.updateMany).not.toHaveBeenCalled();
    });
});

describe("a sprint", () => {
    it("is edited, moved on and deleted only inside the authorized space", async () => {
        await planning.updateSprint(SPACE, "s1", {
            name: "One",
            goal: "",
            startDate: "2026-09-01",
            endDate: "2026-09-14"
        } as Parameters<typeof planning.updateSprint>[2]);
        expect(taskSprint.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "s1", spaceId: SPACE } }));

        await planning.deleteSprint(SPACE, "s1");
        expect(taskSprint.deleteMany).toHaveBeenCalledWith({ where: { id: "s1", spaceId: SPACE } });
    });

    it("refuses another space's sprint, and a task moved into one", async () => {
        taskSprint.findFirst.mockResolvedValue(null);
        taskSprint.deleteMany.mockResolvedValue({ count: 0 });
        await expect(planning.setSprintStatus(SPACE, "elsewhere", "completed")).rejects.toThrow(/not in this space/);
        await expect(planning.deleteSprint(SPACE, "elsewhere")).rejects.toThrow(/not in this space/);
        await expect(planning.setTaskSprint(SPACE, TASK, "elsewhere")).rejects.toThrow(/not in this space/);
        expect(taskSprint.update).not.toHaveBeenCalled();
        expect(task.update).not.toHaveBeenCalled();
    });
});

describe("a time entry", () => {
    it("is removed by a moderator only on the task they moderate", async () => {
        await time.deleteTimeEntry("u1", TASK, "e1", true);
        expect(taskTimeEntry.deleteMany).toHaveBeenCalledWith({ where: { id: "e1", taskId: TASK } });
    });
});

describe("a checklist, its steps and a link", () => {
    it("keeps every write to the authorized task", async () => {
        await details.deleteChecklist(TASK, "c1");
        expect(taskChecklist.deleteMany).toHaveBeenCalledWith({ where: { id: "c1", taskId: TASK } });

        await details.setChecklistItemDone(TASK, "i1", true);
        expect(taskChecklistItem.updateMany).toHaveBeenCalledWith(
            expect.objectContaining({ where: { id: "i1", checklist: { taskId: TASK } } })
        );

        await details.deleteChecklistItem(TASK, "i1");
        expect(taskChecklistItem.deleteMany).toHaveBeenCalledWith({ where: { id: "i1", checklist: { taskId: TASK } } });

        await details.removeDependency(TASK, "d1");
        expect(taskDependency.deleteMany).toHaveBeenCalledWith({
            where: { id: "d1", OR: [{ blockerId: TASK }, { blockedId: TASK }] }
        });
    });

    it("refuses a step on another task, and never promotes it", async () => {
        taskChecklist.findFirst.mockResolvedValue(null);
        await expect(details.addChecklistItem(TASK, "elsewhere", "Step")).rejects.toThrow(/no longer exists/);
        expect(taskChecklistItem.create).not.toHaveBeenCalled();

        taskChecklistItem.findUnique.mockResolvedValue({ name: "Theirs", checklist: { taskId: "task-2" } });
        const create = vi.fn(async () => ({ id: "new" }));
        expect(await details.promoteChecklistItem(TASK, "i-elsewhere", create)).toBeNull();
        expect(create).not.toHaveBeenCalled();
        expect(taskChecklistItem.deleteMany).not.toHaveBeenCalled();
    });
});
