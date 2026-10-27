/**
 * The actions that arrange and rename the work inside a task.
 *
 * Each checks its input against the shared schema before anything is read,
 * asks for the same role editing the task does - a guest may tick a step but
 * never reshape the work - and hands the service exactly what was validated.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const requireTask = vi.fn();
const details = {
    moveDependency: vi.fn(),
    renameChecklist: vi.fn(),
    renameChecklistItem: vi.fn(),
    moveChecklist: vi.fn(),
    moveChecklistItem: vi.fn()
};

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/session", () => ({
    requirePermission: vi.fn(async () => ({ id: "user-1", isAdmin: false })),
    requireUser: vi.fn(),
    sessionCan: vi.fn()
}));
vi.mock("@/lib/tasks/access", () => ({ requireTask }));
vi.mock("@/lib/tasks/task-detail-service", () => details);
vi.mock("@/lib/tasks/live", () => ({ publishTaskChange: vi.fn() }));
vi.mock("@/lib/i18n/request", () => ({
    getTranslations: async () => (key: string) => key
}));
vi.mock("@/lib/tasks/refusal", () => ({
    refusalText: (_t: unknown, caught: unknown) =>
        caught instanceof Error && caught.message === "refused" ? "refused" : null
}));
for (const path of [
    "@polaris/db",
    "@/lib/orgs/org-service",
    "@/lib/tasks/doc-service",
    "@/lib/tasks/time-service",
    "@/lib/audit-service",
    "@/lib/workspace-scope",
    "@/lib/agents/agent-readiness",
    "@/app/(app)/apps/agents/sessions/actions",
    "@/lib/tasks/task-service",
    "@/lib/tasks/view-service",
    "@/lib/tasks/form-service",
    "@/lib/tasks/space-service",
    "@/lib/tasks/share-service",
    "@/lib/tasks/commit-service",
    "@/lib/tasks/attachment-service",
    "@/lib/tasks/planning-service",
    "@/lib/tasks/automation-service"
]) {
    vi.doMock(path, () => ({}));
}

const actions = await import("@/app/(app)/tasks/actions");

const TASK = "0190a000-0000-7000-8000-000000000001";
const EDGE = "0190a000-0000-7000-8000-000000000002";
const NEIGHBOUR = "0190a000-0000-7000-8000-000000000003";

beforeEach(() => {
    requireTask.mockReset();
    requireTask.mockResolvedValue({ spaceId: "space-1", listId: "list-1", role: "member" });
    for (const method of Object.values(details)) method.mockReset();
});

describe("moving a dependency", () => {
    it("asks for the role that edits the task, and passes the validated move", async () => {
        const result = await actions.moveDependencyAction(TASK, EDGE, {
            direction: "waitingOn",
            afterId: NEIGHBOUR
        });
        expect(result).toEqual({});
        expect(requireTask).toHaveBeenCalledWith(expect.anything(), TASK, "member");
        expect(details.moveDependency).toHaveBeenCalledWith(TASK, EDGE, {
            direction: "waitingOn",
            beforeId: null,
            afterId: NEIGHBOUR
        });
    });

    it("refuses a move that names no list, or a neighbour that is not an id", async () => {
        for (const move of [
            { beforeId: null, afterId: null },
            { direction: "sideways", beforeId: null, afterId: null },
            { direction: "blocking", beforeId: "not-an-id", afterId: null },
            null
        ]) {
            const result = await actions.moveDependencyAction(TASK, EDGE, move);
            expect(result.error).toBe("errors.dropPlace");
        }
        expect(requireTask).not.toHaveBeenCalled();
        expect(details.moveDependency).not.toHaveBeenCalled();
    });

    it("writes nothing for somebody who cannot edit the task", async () => {
        requireTask.mockRejectedValue(new Error("refused"));
        const result = await actions.moveDependencyAction(TASK, EDGE, {
            direction: "blocking",
            beforeId: null,
            afterId: null
        });
        expect(result.error).toBe("refused");
        expect(details.moveDependency).not.toHaveBeenCalled();
    });
});

describe("renaming a checklist", () => {
    it("saves the trimmed name under the edit role", async () => {
        const result = await actions.renameChecklistAction(TASK, EDGE, "  Launch  ");
        expect(result).toEqual({});
        expect(requireTask).toHaveBeenCalledWith(expect.anything(), TASK, "member");
        expect(details.renameChecklist).toHaveBeenCalledWith(TASK, EDGE, "Launch");
    });

    it("refuses a blank name, one past the checklist limit, and anything not text", async () => {
        for (const name of ["   ", "x".repeat(65), 42, undefined]) {
            const result = await actions.renameChecklistAction(TASK, EDGE, name);
            expect(result.error).toBeTruthy();
        }
        expect(details.renameChecklist).not.toHaveBeenCalled();
    });

    it("writes nothing for somebody who cannot edit the task", async () => {
        requireTask.mockRejectedValue(new Error("refused"));
        const result = await actions.renameChecklistAction(TASK, EDGE, "Launch");
        expect(result.error).toBe("refused");
        expect(details.renameChecklist).not.toHaveBeenCalled();
    });
});

describe("renaming a step", () => {
    it("saves the trimmed name under the edit role", async () => {
        const result = await actions.renameChecklistItemAction(TASK, EDGE, " Ship it ");
        expect(result).toEqual({});
        expect(requireTask).toHaveBeenCalledWith(expect.anything(), TASK, "member");
        expect(details.renameChecklistItem).toHaveBeenCalledWith(TASK, EDGE, "Ship it");
    });

    it("takes the longer name a step allows, and refuses a blank one", async () => {
        expect(await actions.renameChecklistItemAction(TASK, EDGE, "x".repeat(200))).toEqual({});
        const blank = await actions.renameChecklistItemAction(TASK, EDGE, "");
        expect(blank.error).toBeTruthy();
        expect(details.renameChecklistItem).toHaveBeenCalledTimes(1);
    });
});
