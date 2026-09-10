/**
 * Saving a batch of variables: nothing redeploys unless asked, a redeploy is asked
 * for with the right to deploy, and an id from another scope is refused before
 * anything is written.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const requireEnvScopeAccess = vi.fn();
const redeployForEnvScope = vi.fn();
const setEnvVar = vi.fn();
const setEnvVarSecrecy = vi.fn();
const deleteEnvVar = vi.fn();
const envVarScope = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/activity/activity", () => ({ record: async () => undefined }));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit: async () => undefined }));
vi.mock("@/lib/deploy-service", () => ({ redeployForEnvScope }));
vi.mock("@/lib/deploy-project-access", () => ({ requireEnvScopeAccess }));
vi.mock("@/lib/deploy/variable-links", () => ({ variableLinks: async () => ({}) }));
vi.mock("@/lib/env-var-service", () => ({ setEnvVar, setEnvVarSecrecy, deleteEnvVar, envVarScope }));

const { saveEnvVarChangesAction, redeployEnvScopeAction } = await import("@/app/(app)/apps/deploy/variable-actions");

const BASE = { scope: "application", scopeId: "app-1", set: [], secrecy: [], remove: [], redeploy: false };

describe("saveEnvVarChangesAction", () => {
    beforeEach(() => {
        for (const mock of [requireEnvScopeAccess, redeployForEnvScope, setEnvVar, setEnvVarSecrecy, deleteEnvVar, envVarScope]) {
            mock.mockReset();
        }
        requireEnvScopeAccess.mockResolvedValue({ ownerId: "owner-1", orgId: null });
        redeployForEnvScope.mockResolvedValue(undefined);
        envVarScope.mockImplementation(async (id: string) => ({ scope: "application", scopeId: "app-1", key: `KEY_${id}` }));
    });

    it("saves without redeploying when a redeploy was not asked for", async () => {
        const result = await saveEnvVarChangesAction({ ...BASE, set: [{ key: "PORT", value: "8080", isSecret: false }] });
        expect(result).toEqual({ saved: 1, redeployed: false });
        expect(setEnvVar).toHaveBeenCalledWith("application", "app-1", "owner-1", { key: "PORT", value: "8080", isSecret: false });
        expect(redeployForEnvScope).not.toHaveBeenCalled();
        expect(requireEnvScopeAccess).toHaveBeenCalledWith("application", "app-1", "user-1", "variables.write");
    });

    it("redeploys once for the whole batch when asked, after checking the right to deploy", async () => {
        const result = await saveEnvVarChangesAction({
            ...BASE,
            set: [
                { key: "A", value: "1", isSecret: false },
                { key: "B", value: "2", isSecret: true }
            ],
            remove: ["v1"],
            redeploy: true
        });
        expect(result).toEqual({ saved: 3, redeployed: true });
        expect(requireEnvScopeAccess).toHaveBeenCalledWith("application", "app-1", "user-1", "deploy.run");
        expect(redeployForEnvScope).toHaveBeenCalledTimes(1);
    });

    it("writes nothing when the right to deploy is missing", async () => {
        requireEnvScopeAccess.mockImplementation(async (_scope, _id, _user, capability: string) => {
            if (capability === "deploy.run") throw new Error("You cannot deploy this service");
            return { ownerId: "owner-1", orgId: null };
        });
        const result = await saveEnvVarChangesAction({
            ...BASE,
            set: [{ key: "A", value: "1", isSecret: false }],
            redeploy: true
        });
        expect(result.error).toBe("You cannot deploy this service");
        expect(setEnvVar).not.toHaveBeenCalled();
    });

    it("refuses a variable id from another scope before writing anything", async () => {
        envVarScope.mockResolvedValue({ scope: "application", scopeId: "someone-else", key: "X" });
        const result = await saveEnvVarChangesAction({
            ...BASE,
            set: [{ key: "A", value: "1", isSecret: false }],
            remove: ["foreign"]
        });
        expect(result.error).toContain("no longer exists");
        expect(deleteEnvVar).not.toHaveBeenCalled();
        expect(setEnvVar).not.toHaveBeenCalled();
    });

    it("flips secrecy through the server, never with a value from the page", async () => {
        await saveEnvVarChangesAction({ ...BASE, secrecy: [{ id: "v2", isSecret: false }] });
        expect(setEnvVarSecrecy).toHaveBeenCalledWith("v2", "owner-1", false);
        expect(setEnvVar).not.toHaveBeenCalled();
    });

    it("refuses a malformed batch", async () => {
        const result = await saveEnvVarChangesAction({ ...BASE, set: [{ key: "9LIVES", value: "", isSecret: false }] });
        expect(result.error).toContain("Letters, digits and underscores");
        expect(requireEnvScopeAccess).not.toHaveBeenCalled();
    });
});

describe("redeployEnvScopeAction", () => {
    it("asks for the right to deploy", async () => {
        requireEnvScopeAccess.mockReset().mockResolvedValue({ ownerId: "owner-1", orgId: null });
        redeployForEnvScope.mockReset().mockResolvedValue(undefined);
        expect(await redeployEnvScopeAction({ scope: "environment", scopeId: "env-1" })).toEqual({});
        expect(requireEnvScopeAccess).toHaveBeenCalledWith("environment", "env-1", "user-1", "deploy.run");
        expect(redeployForEnvScope).toHaveBeenCalledWith("environment", "env-1", "owner-1");
    });
});
