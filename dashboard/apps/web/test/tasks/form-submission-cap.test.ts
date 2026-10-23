/**
 * A form's cap on submissions holds when several arrive for the last slot: the
 * submission takes its slot under the form's row lock before a task is filed,
 * and a slot whose task could not be filed is given back.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DB_PROVIDER: "postgresql" }) }));

const createTask = vi.fn();
vi.mock("@/lib/tasks/task-service", () => ({ createTask }));

const findUnique = vi.fn();
const count = vi.fn();
const create = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const queryRaw = vi.fn();
const tx = { $queryRaw: queryRaw, taskFormSubmission: { count, create } };
vi.mock("@polaris/db", () => ({
    prisma: {
        taskForm: { findUnique },
        taskFormSubmission: { update, delete: remove },
        taskCustomFieldValue: { create: vi.fn() },
        $transaction: async (run: (client: typeof tx) => unknown) => run(tx)
    }
}));

const { submitForm } = await import("@/lib/tasks/form-service");

const FORM = {
    id: "01a081bf-94a6-76c1-9907-ab70aa5f6471",
    spaceId: "space-1",
    listId: "list-1",
    fields: JSON.stringify([{ id: "q1", label: "What", type: "text", required: true, options: [], mapsTo: "" }]),
    defaultStatusId: null,
    confirmation: "",
    requireLogin: false,
    enabled: true,
    maxSubmissions: 2,
    createdById: null
};

beforeEach(() => {
    vi.clearAllMocks();
    findUnique.mockResolvedValue(FORM);
    create.mockResolvedValue({ id: "slot-1" });
    createTask.mockResolvedValue({ id: "task-1" });
});

describe("submitting a form with a cap", () => {
    it("files the task against the slot it took, under the form's lock", async () => {
        count.mockResolvedValue(1);
        const result = await submitForm("token", { q1: "Help" }, null);
        expect(result.ok).toBe(true);
        expect(queryRaw).toHaveBeenCalledOnce();
        expect(create).toHaveBeenCalledOnce();
        expect(update).toHaveBeenCalledWith({ where: { id: "slot-1" }, data: { taskId: "task-1" } });
    });

    it("refuses once the cap is reached, filing nothing", async () => {
        count.mockResolvedValue(2);
        const result = await submitForm("token", { q1: "Help" }, null);
        expect(result.ok).toBe(false);
        expect(create).not.toHaveBeenCalled();
        expect(createTask).not.toHaveBeenCalled();
    });

    it("gives the slot back when the task cannot be filed", async () => {
        count.mockResolvedValue(0);
        createTask.mockRejectedValueOnce(new Error("down"));
        remove.mockResolvedValue({});
        await expect(submitForm("token", { q1: "Help" }, null)).rejects.toThrow("down");
        expect(remove).toHaveBeenCalledWith({ where: { id: "slot-1" } });
    });
});
