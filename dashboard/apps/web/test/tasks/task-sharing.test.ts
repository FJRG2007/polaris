/**
 * One task shared with somebody (`task.task`): read through a grant only, as the
 * names-only view a link shows, and handed out by whoever may link it.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const TASK = "0192f0aa-0000-7000-8000-0000000000c5";

const state = vi.hoisted(() => ({ held: "", reads: 0, member: false }));

vi.mock("@polaris/db", () => ({
    prisma: {
        task: {
            findUnique: vi.fn(async () => {
                state.reads += 1;
                return {
                    id: "0192f0aa-0000-7000-8000-0000000000c5",
                    number: 4,
                    name: "Ship it",
                    description: "",
                    priority: "none",
                    startDate: null,
                    dueDate: null,
                    timed: false,
                    points: null,
                    createdAt: new Date(0),
                    updatedAt: new Date(0),
                    space: { prefix: "OPS" },
                    status: { name: "Open", color: "#000000", type: "open" },
                    assignees: [{ user: { name: "Ana" } }],
                    tags: [],
                    subtasks: [],
                    checklists: []
                };
            })
        },
        comment: { findMany: vi.fn(async () => []) }
    }
}));
vi.mock("@/lib/access/grants", () => ({
    grantedCapability: vi.fn(async () => state.held),
    GrantError: class GrantError extends Error {}
}));
vi.mock("@/lib/session", () => ({ sessionCan: vi.fn(async () => false) }));
vi.mock("@/lib/orgs/org-service", () => ({ memberOrgIds: vi.fn(async () => []) }));
vi.mock("@/lib/notes/access", () => ({ requireSpace: vi.fn(), requireNote: vi.fn() }));
vi.mock("@/lib/office/documents", () => ({ requireShareable: vi.fn() }));
vi.mock("@/lib/chat/access", () => ({ requireSpace: vi.fn(), requireChannel: vi.fn() }));
vi.mock("@/lib/tasks/access", () => ({
    requireSpace: vi.fn(),
    requireFolder: vi.fn(),
    requireTask: vi.fn(async () => {
        if (!state.member) throw new Error("no access");
        return {};
    })
}));
vi.mock("@/lib/machines/machine-access", () => ({ domainOwner: vi.fn(), lendableServer: vi.fn() }));

const { sharedTaskView } = await import("@/lib/tasks/share-service");
const { requireMayShare, subjectHref } = await import("@/lib/access/sharing-service");

type Sharer = Parameters<typeof requireMayShare>[0];

describe("a task shared on its own", () => {
    beforeEach(() => {
        state.held = "";
        state.reads = 0;
        state.member = false;
    });

    it("is read only through a grant, as the names-only view", async () => {
        expect(await sharedTaskView(TASK, "reader")).toBeNull();
        expect(state.reads).toBe(0);
        state.held = "view";
        const view = await sharedTaskView(TASK, "reader");
        expect(view).toMatchObject({ reference: "OPS-4", name: "Ship it", assignees: ["Ana"], comments: [] });
        expect(view).not.toHaveProperty("id");
    });

    it("is handed out by whoever may link it, and leads to its own page", async () => {
        const as = { id: "u", isAdmin: false } as Sharer;
        await expect(requireMayShare(as, "task.task", TASK)).rejects.toThrow();
        state.member = true;
        await expect(requireMayShare(as, "task.task", TASK)).resolves.toBeUndefined();
        expect(subjectHref("task.task", TASK)).toBe(`/tasks/t/${TASK}`);
    });
});
