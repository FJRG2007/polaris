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
const listEnvVars = vi.fn();
const revealEnvVar = vi.fn();
const recordDeployAudit = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/activity/activity", () => ({ record: async () => undefined }));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit }));
vi.mock("@/lib/deploy-service", () => ({ redeployForEnvScope }));
vi.mock("@/lib/deploy-project-access", () => ({ requireEnvScopeAccess }));
vi.mock("@/lib/deploy/variable-links", () => ({ variableLinks: async () => ({}) }));
vi.mock("@/lib/env-var-service", () => ({
    setEnvVar,
    setEnvVarSecrecy,
    deleteEnvVar,
    envVarScope,
    listEnvVars,
    revealEnvVar
}));

const { saveEnvVarChangesAction, redeployEnvScopeAction, revealEnvScopeAction, promoteEnvVarAction } =
    await import("@/app/(app)/apps/deploy/variable-actions");

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
        expect(redeployForEnvScope).toHaveBeenCalledWith("environment", "env-1", "owner-1", "user-1");
    });
});

describe("revealEnvScopeAction", () => {
    beforeEach(() => {
        for (const mock of [requireEnvScopeAccess, listEnvVars, revealEnvVar, recordDeployAudit]) mock.mockReset();
        requireEnvScopeAccess.mockResolvedValue({ ownerId: "owner-1", orgId: null, environmentId: "env-1" });
        listEnvVars.mockResolvedValue([
            { id: "v1", key: "DATABASE_URL", isSecret: true, value: null },
            { id: "v2", key: "NODE_ENV", isSecret: false, value: "production" }
        ]);
        revealEnvVar.mockResolvedValue("postgres://u:p@db/app");
    });

    it("hands every value over to somebody who may read them, and writes down which secrets were seen", async () => {
        const result = await revealEnvScopeAction({ scope: "application", scopeId: "app-1" });
        expect(result).toEqual({ values: { v1: "postgres://u:p@db/app", v2: "production" } });
        expect(requireEnvScopeAccess).toHaveBeenCalledWith("application", "app-1", "user-1", "variables.read");
        expect(revealEnvVar).toHaveBeenCalledTimes(1);
        expect(recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({ action: "deploy.variable.reveal", metadata: { keys: ["DATABASE_URL"] } })
        );
    });

    it("reveals nothing to somebody who may not read them", async () => {
        requireEnvScopeAccess.mockRejectedValue(new Error("You cannot see this service"));
        expect(await revealEnvScopeAction({ scope: "application", scopeId: "app-1" })).toEqual({
            error: "You cannot see this service"
        });
        expect(revealEnvVar).not.toHaveBeenCalled();
    });
});

describe("promoteEnvVarAction", () => {
    beforeEach(() => {
        for (const mock of [requireEnvScopeAccess, listEnvVars, revealEnvVar, setEnvVar, envVarScope, recordDeployAudit])
            mock.mockReset();
        requireEnvScopeAccess.mockResolvedValue({ ownerId: "owner-1", orgId: null, environmentId: "env-1" });
        envVarScope.mockResolvedValue({ scope: "application", scopeId: "app-1", key: "STRIPE_KEY" });
        listEnvVars.mockImplementation(async (scope: string) =>
            scope === "application"
                ? [{ id: "v1", key: "STRIPE_KEY", isSecret: true, value: null }]
                : [{ id: "s1", key: "OTHER", isSecret: false, value: "x" }]
        );
        revealEnvVar.mockResolvedValue("sk_live_123");
    });

    it("moves the value to the environment's shared variables and points the service at it", async () => {
        expect(await promoteEnvVarAction({ id: "v1" })).toEqual({ key: "STRIPE_KEY" });
        expect(requireEnvScopeAccess).toHaveBeenCalledWith("application", "app-1", "user-1", "variables.write");
        expect(requireEnvScopeAccess).toHaveBeenCalledWith("environment", "env-1", "user-1", "variables.write");
        expect(setEnvVar).toHaveBeenNthCalledWith(1, "environment", "env-1", "owner-1", {
            key: "STRIPE_KEY",
            value: "sk_live_123",
            isSecret: true
        });
        expect(setEnvVar).toHaveBeenNthCalledWith(2, "application", "app-1", "owner-1", {
            key: "STRIPE_KEY",
            value: "${{shared.STRIPE_KEY}}",
            isSecret: false
        });
    });

    it("refuses when the environment already shares a variable by that name, and changes nothing", async () => {
        listEnvVars.mockImplementation(async (scope: string) =>
            scope === "application"
                ? [{ id: "v1", key: "STRIPE_KEY", isSecret: true, value: null }]
                : [{ id: "s1", key: "STRIPE_KEY", isSecret: true, value: null }]
        );
        const result = await promoteEnvVarAction({ id: "v1" });
        expect(result.error).toContain("STRIPE_KEY");
        expect(setEnvVar).not.toHaveBeenCalled();
    });

    it("only promotes a service's own variable", async () => {
        envVarScope.mockResolvedValue({ scope: "environment", scopeId: "env-1", key: "STRIPE_KEY" });
        expect((await promoteEnvVarAction({ id: "v1" })).error).toBeTruthy();
        expect(setEnvVar).not.toHaveBeenCalled();
    });

    it("does not promote one that already points at a shared variable", async () => {
        listEnvVars.mockImplementation(async (scope: string) =>
            scope === "application"
                ? [{ id: "v1", key: "STRIPE_KEY", isSecret: false, value: "${{shared.STRIPE_KEY}}" }]
                : []
        );
        revealEnvVar.mockResolvedValue("${{shared.STRIPE_KEY}}");
        expect((await promoteEnvVarAction({ id: "v1" })).error).toBeTruthy();
        expect(setEnvVar).not.toHaveBeenCalled();
    });
});
