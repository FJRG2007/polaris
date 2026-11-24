/**
 * A task a device made offline arrives with the id it was made under, and may
 * arrive more than once (an answer lost on the way back, two tabs replaying at
 * once): it is made once, and every replay is answered with that task.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = { id: string; spaceId: string; number: number };
let rows: Row[] = [];
let creates = 0;
/** Set to make the next create lose a race to a replay that got there first. */
let racedBy: Row | null = null;

vi.mock("@/lib/tasks/numbering", () => ({ nextTaskNumber: async () => ({ number: rows.length + 1, prefix: "ENG" }) }));
vi.mock("@/lib/tasks/automation-service", () => ({
    hasAutomationsFor: async () => false,
    runAutomations: async () => undefined,
    runAutomationsFor: async () => undefined
}));
vi.mock("@/lib/rich-text/mention-notify", () => ({ notifyMentions: async () => undefined }));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: async () => undefined }));
vi.mock("@polaris/db", () => {
    const task = {
        findFirst: async (args: { where: { id: string; spaceId: string } }) => {
            const row = rows.find((entry) => entry.id === args.where.id && entry.spaceId === args.where.spaceId);
            return row ? { id: row.id, number: row.number, space: { prefix: "ENG" } } : null;
        },
        findFirstOrThrow: async () => ({}),
        create: async (args: { data: Row }) => {
            if (racedBy) {
                rows.push(racedBy);
                racedBy = null;
            }
            if (rows.some((entry) => entry.id === args.data.id))
                throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
            creates += 1;
            rows.push({ id: args.data.id, spaceId: args.data.spaceId, number: args.data.number });
            return { id: args.data.id };
        }
    };
    const prisma = {
        task,
        taskStatus: { findFirst: async () => ({ id: "status" }), findFirstOrThrow: async () => ({ id: "status" }) },
        activity: { create: async () => ({}) },
        taskActivity: { create: async () => ({}) },
        $transaction: async (run: (tx: unknown) => Promise<unknown>) => run(prisma)
    };
    return { prisma };
});

const core = await import("@polaris/core");
const { createTask } = await import("@/lib/tasks/task-service");

const SPACE = "0190a1b2-c3d4-7e5f-8a9b-0000000000aa";
const LIST = "0190a1b2-c3d4-7e5f-8a9b-0000000000bb";
const ID = "0190a1b2-c3d4-7e5f-8a9b-0000000000cc";

const input = () => core.taskCreateSchema.parse({ id: ID, listId: LIST, name: "Made offline", statusId: undefined });

beforeEach(() => {
    rows = [];
    creates = 0;
    racedBy = null;
});

describe("createTask with an id from the device", () => {
    it("makes the task under that id", async () => {
        const made = await createTask("u1", SPACE, input());
        expect(made).toEqual({ id: ID, reference: "ENG-1" });
        expect(creates).toBe(1);
    });

    it("answers a replay with the task already made, and makes nothing", async () => {
        await createTask("u1", SPACE, input());
        const again = await createTask("u1", SPACE, input());
        expect(again).toEqual({ id: ID, reference: "ENG-1" });
        expect(creates).toBe(1);
    });

    it("answers with the other replay's task when both arrive at once", async () => {
        racedBy = { id: ID, spaceId: SPACE, number: 7 };
        const made = await createTask("u1", SPACE, input());
        expect(made).toEqual({ id: ID, reference: "ENG-7" });
        expect(creates).toBe(0);
    });

    it("does not answer with a task of that id in another space", async () => {
        rows.push({ id: ID, spaceId: "another", number: 3 });
        await expect(createTask("u1", SPACE, input())).rejects.toThrow("Unique constraint failed");
    });
});
