/**
 * The issue workflow's server side: who may hand an issue to whom, who may
 * make a task of it, and what that task is made with.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT = "0192f0aa-0000-7000-8000-0000000000d1";
const ISSUE = "0192f0aa-0000-7000-8000-0000000000e1";
const LIST = "0192f0aa-0000-7000-8000-0000000000f1";
const PERSON = "0192f0aa-0000-7000-8000-0000000000a1";

const state = vi.hoisted(() => ({
    granted: new Map<string, string>(),
    manages: true,
    tasks: true,
    mayRead: true,
    assignee: null as { id: string; name: string } | null
}));

const workflow = vi.hoisted(() => ({
    issuesByIds: vi.fn(async () => [{ id: ISSUE_ID, projectId: PROJECT_ID, lastRelease: "1.0", title: "Boom" }]),
    assignMany: vi.fn(async () => undefined),
    notifyAssigned: vi.fn(async () => undefined),
    setStatusMany: vi.fn(async () => undefined),
    mayRead: vi.fn(async () => state.mayRead),
    issueMeta: vi.fn(async () => ({ assignee: state.assignee, resolvedInRelease: null })),
    addActivity: vi.fn(async () => undefined)
}));
const ISSUE_ID = "0192f0aa-0000-7000-8000-0000000000e1";
const PROJECT_ID = "0192f0aa-0000-7000-8000-0000000000d1";

const createTask = vi.hoisted(() => vi.fn(async () => ({ id: "task-1", reference: "OPS-7" })));
const requireList = vi.hoisted(() => vi.fn(async () => ({ listId: "l", spaceId: "space-1", folderId: null, role: "member" })));

vi.mock("@/lib/telemetry/workflow-service", () => workflow);
vi.mock("@/lib/tasks/task-service", () => ({ createTask }));
vi.mock("@/lib/tasks/access", () => ({
    requireList,
    TaskAccessError: class TaskAccessError extends Error {}
}));
vi.mock("@/lib/telemetry/project-service", () => ({
    TelemetryAccessError: class TelemetryAccessError extends Error {
        constructor(message = "You do not have access to that project") {
            super(message);
        }
    },
    requireProject: vi.fn(async (_actor: unknown, id: string, lent: ReadonlySet<string>) => {
        if (!state.manages && !lent.has(id)) throw new Error("no access");
        return { id };
    }),
    listProjects: vi.fn(async () => []),
    dsnFor: vi.fn(() => "dsn")
}));
vi.mock("@/lib/access/grants", () => ({
    grantedSubjects: vi.fn(async () => new Map(state.granted)),
    dropGrantsFor: vi.fn()
}));
vi.mock("@/lib/session", () => ({
    requireUser: vi.fn(async () => ({ id: "0192f0aa-0000-7000-8000-0000000000c1", isAdmin: false, name: "Caller" })),
    sessionCan: vi.fn(async (_user: unknown, permission: string) =>
        permission === "tasks.manage" ? state.tasks : state.manages
    ),
    requirePermission: vi.fn(async () => ({ id: "0192f0aa-0000-7000-8000-0000000000c1", isAdmin: false }))
}));
vi.mock("@/lib/telemetry/report-service", () => ({ TELEMETRY_WINDOW_DAYS: 30 }));
vi.mock("@/lib/people-search", () => ({ findPeople: vi.fn(async () => ({ people: [] })) }));
vi.mock("@/lib/domain-service", () => ({ appBaseUrl: vi.fn(async () => "https://polaris.example.test") }));
vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: vi.fn(async () => null) }));
vi.mock("@polaris/deploy", () => ({ slugify: (value: string) => value }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: async () => (key: string) => key }));

const actions = await import("@/app/(app)/telemetry/actions");

describe("the issue workflow", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        state.granted = new Map();
        state.manages = true;
        state.tasks = true;
        state.mayRead = true;
        state.assignee = null;
    });

    it("refuses input that is not ids", async () => {
        expect(await actions.assignIssuesAction({ issueIds: ["x"], assigneeId: null })).toEqual({
            error: "errors.assign"
        });
        expect(await actions.bulkStatusAction({ issueIds: [ISSUE], status: "deleted" })).toEqual({
            error: "errors.badStatus"
        });
        expect(workflow.assignMany).not.toHaveBeenCalled();
    });

    it("assigns somebody who can open the project", async () => {
        expect(await actions.assignIssuesAction({ issueIds: [ISSUE], assigneeId: PERSON })).toEqual({});
        expect(workflow.assignMany).toHaveBeenCalledWith(expect.any(Array), PERSON, "0192f0aa-0000-7000-8000-0000000000c1");
        // And the person it went to hears about it.
        expect(workflow.notifyAssigned).toHaveBeenCalledWith(expect.any(Array), PERSON, "0192f0aa-0000-7000-8000-0000000000c1");
    });

    it("never hands an issue to somebody who could not see it", async () => {
        state.mayRead = false;
        expect(await actions.assignIssuesAction({ issueIds: [ISSUE], assigneeId: PERSON })).toEqual({
            error: "errors.assigneeCannotSee"
        });
        expect(workflow.assignMany).not.toHaveBeenCalled();
    });

    it("lets nobody but an editor change an issue", async () => {
        state.manages = false;
        state.granted = new Map([[PROJECT, "view"]]);
        const answer = await actions.bulkStatusAction({ issueIds: [ISSUE], status: "resolved", mode: "now" });
        expect(answer.error).toBeTruthy();
        expect(workflow.setStatusMany).not.toHaveBeenCalled();
    });

    it("resolves in the mode it was asked for", async () => {
        expect(
            await actions.bulkStatusAction({ issueIds: [ISSUE], status: "resolved", mode: "nextRelease" })
        ).toEqual({});
        expect(workflow.setStatusMany).toHaveBeenCalledWith(expect.any(Array), "resolved", "0192f0aa-0000-7000-8000-0000000000c1", "nextRelease");
    });

    it("makes a task for whoever has the issue, and notes it on the issue", async () => {
        state.assignee = { id: PERSON, name: "Ana" };
        const made = await actions.createIssueTaskAction({
            projectId: PROJECT,
            issueId: ISSUE,
            listId: LIST,
            name: "TypeError",
            description: "link"
        });
        expect(made).toEqual({ id: "task-1", reference: "OPS-7" });
        expect(requireList).toHaveBeenCalledWith(expect.objectContaining({ id: "0192f0aa-0000-7000-8000-0000000000c1" }), LIST, "member");
        expect(createTask).toHaveBeenCalledWith(
            "0192f0aa-0000-7000-8000-0000000000c1",
            "space-1",
            expect.objectContaining({ listId: LIST, name: "TypeError", description: "link", assigneeIds: [PERSON] })
        );
        expect(workflow.addActivity).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "task", ref: "task-1", issueId: ISSUE })
        );
    });

    it("puts the caller on it when nobody has the issue, and nobody when asked not to", async () => {
        await actions.createIssueTaskAction({ projectId: PROJECT, issueId: ISSUE, listId: LIST, name: "x" });
        expect(createTask).toHaveBeenLastCalledWith("0192f0aa-0000-7000-8000-0000000000c1", "space-1", expect.objectContaining({ assigneeIds: ["0192f0aa-0000-7000-8000-0000000000c1"] }));
        await actions.createIssueTaskAction({
            projectId: PROJECT,
            issueId: ISSUE,
            listId: LIST,
            name: "x",
            assign: false
        });
        expect(createTask).toHaveBeenLastCalledWith("0192f0aa-0000-7000-8000-0000000000c1", "space-1", expect.objectContaining({ assigneeIds: [] }));
    });

    it("makes no task for an account that cannot make tasks", async () => {
        state.tasks = false;
        expect(
            await actions.createIssueTaskAction({ projectId: PROJECT, issueId: ISSUE, listId: LIST, name: "x" })
        ).toEqual({ error: "errors.noTasks" });
        expect(await actions.taskListsAction("")).toEqual({ error: "errors.noTasks" });
        expect(createTask).not.toHaveBeenCalled();
    });
});
