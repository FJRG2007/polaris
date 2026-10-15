/**
 * The variable group actions: a link needs the right to change the service's
 * variables, a refusal from the group is said in words, and input that does not
 * fit the schema never reaches the database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    requireApplicationAccess: vi.fn(),
    requireProjectAccess: vi.fn(),
    linkGroup: vi.fn(),
    unlinkGroup: vi.fn(),
    createGroup: vi.fn(),
    deleteGroup: vi.fn(),
    updateGroup: vi.fn(),
    requirePermission: vi.fn(),
    recordDeployAudit: vi.fn(),
    projectUpdate: vi.fn()
}));

class VariableGroupError extends Error {
    constructor(readonly code: string) {
        super(code);
    }
}

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/lib/workspace-scope", () => ({ scopeOrgIdFor: async () => "org-1" }));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit: mocks.recordDeployAudit }));
vi.mock("@/app/(app)/apps/deploy/reply", () => ({ reply: async (key: string) => `words:${key}` }));
vi.mock("@polaris/db", () => ({ prisma: { project: { update: mocks.projectUpdate } } }));
vi.mock("@/lib/deploy-project-access", () => ({
    accessCan: () => true,
    requireApplicationAccess: mocks.requireApplicationAccess,
    requireProjectAccess: mocks.requireProjectAccess
}));
vi.mock("@/lib/deploy/variable-groups", () => ({
    VariableGroupError,
    linkGroup: mocks.linkGroup,
    unlinkGroup: mocks.unlinkGroup,
    createGroup: mocks.createGroup,
    deleteGroup: mocks.deleteGroup,
    updateGroup: mocks.updateGroup
}));

const actions = await import("@/app/(app)/apps/deploy/variable-group-actions");

beforeEach(() => {
    for (const fn of Object.values(mocks)) fn.mockReset();
    mocks.requirePermission.mockResolvedValue({ id: "user-1", isAdmin: false });
});

describe("the instance permission", () => {
    it("is deploy.manage for every change to a group or a link", async () => {
        mocks.requireApplicationAccess.mockResolvedValue({ ownerId: "owner-1" });
        mocks.createGroup.mockResolvedValue({ id: "g-new" });
        mocks.deleteGroup.mockResolvedValue({ linked: 0, orgId: null });
        mocks.updateGroup.mockResolvedValue({ orgId: null });
        await actions.createVariableGroupAction({ name: "Payments", description: "" });
        await actions.updateVariableGroupAction({ groupId: "g-1", name: "Payments", description: "" });
        await actions.deleteVariableGroupAction({ groupId: "g-1" });
        await actions.linkVariableGroupAction({ applicationId: "app-1", groupId: "g-1" });
        await actions.unlinkVariableGroupAction({ applicationId: "app-1", groupId: "g-1" });
        expect(mocks.requirePermission.mock.calls.map((call) => call[0])).toEqual(
            Array.from({ length: 5 }, () => "deploy.manage")
        );
    });
});

describe("deleting", () => {
    it("names the group's organization in the audit, read before the row went", async () => {
        mocks.deleteGroup.mockResolvedValue({ linked: 2, orgId: "org-7" });
        expect(await actions.deleteVariableGroupAction({ groupId: "g-1" })).toEqual({ linked: 2 });
        expect(mocks.recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "deploy.variable-group.delete", orgId: "org-7" })
        );
    });
});

describe("linking", () => {
    it("is refused without the right to change the service's variables", async () => {
        mocks.requireApplicationAccess.mockRejectedValue(new Error("forbidden"));
        const result = await actions.linkVariableGroupAction({ applicationId: "app-1", groupId: "g-1" });
        expect(result).toEqual({ error: "words:variableGroups.failed" });
        expect(mocks.requireApplicationAccess).toHaveBeenCalledWith("app-1", "user-1", "variables.write");
        expect(mocks.linkGroup).not.toHaveBeenCalled();
    });

    it("says why a group cannot be linked", async () => {
        mocks.requireApplicationAccess.mockResolvedValue({ ownerId: "owner-1" });
        mocks.linkGroup.mockRejectedValue(new VariableGroupError("notFound"));
        const result = await actions.linkVariableGroupAction({ applicationId: "app-1", groupId: "g-1" });
        expect(result).toEqual({ error: "words:variableGroups.notFound" });
        expect(mocks.recordDeployAudit).not.toHaveBeenCalled();
    });

    it("links and records who did it", async () => {
        mocks.requireApplicationAccess.mockResolvedValue({ ownerId: "owner-1" });
        mocks.linkGroup.mockResolvedValue(undefined);
        expect(await actions.linkVariableGroupAction({ applicationId: "app-1", groupId: "g-1" })).toEqual({});
        expect(mocks.linkGroup).toHaveBeenCalledWith({ id: "user-1", isAdmin: false }, "app-1", "g-1");
        expect(mocks.recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "deploy.variable-group.link", targetId: "app-1" })
        );
    });

    it("refuses input that is not a pair of ids", async () => {
        const result = await actions.linkVariableGroupAction({ applicationId: "", groupId: 4 });
        expect(result.error).toBeDefined();
        expect(mocks.requireApplicationAccess).not.toHaveBeenCalled();
    });
});

describe("creating", () => {
    it("refuses a nameless group before reaching the database", async () => {
        const result = await actions.createVariableGroupAction({ name: "   ", description: "" });
        expect(result).toEqual({ error: "words:variableGroups.nameRequired" });
        expect(mocks.createGroup).not.toHaveBeenCalled();
    });

    it("creates on the open workspace's shelf", async () => {
        mocks.createGroup.mockResolvedValue({ id: "g-new" });
        expect(await actions.createVariableGroupAction({ name: "Payments", description: "" })).toEqual({
            id: "g-new"
        });
        expect(mocks.createGroup.mock.calls[0][1]).toBe("org-1");
    });
});

describe("project tags", () => {
    it("stores normalized tags once the project's settings may be changed", async () => {
        mocks.requireProjectAccess.mockResolvedValue({});
        const result = await actions.setProjectTagsAction({ projectId: "p-1", tags: ["Production", "production"] });
        expect(result.error).toBeUndefined();
        expect(mocks.requireProjectAccess).toHaveBeenCalledWith("p-1", "user-1", "project.settings");
        const stored = JSON.parse(mocks.projectUpdate.mock.calls[0][0].data.tags) as string[];
        expect(stored).toEqual(result.tags);
    });

    it("writes nothing when the settings are not theirs", async () => {
        mocks.requireProjectAccess.mockRejectedValue(new Error("forbidden"));
        const result = await actions.setProjectTagsAction({ projectId: "p-1", tags: ["prod"] });
        expect(result).toEqual({ error: "words:variableGroups.tagsFailed" });
        expect(mocks.projectUpdate).not.toHaveBeenCalled();
    });
});
