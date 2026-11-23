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
const promoteEnvVar = vi.fn();
const sealedValue = vi.fn();
const sealEnvVar = vi.fn();
const setEnvVarGenerator = vi.fn();
const environmentReferrers = vi.fn(async () => [] as string[]);
const recordDeployAudit = vi.fn();

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "user-1" }) }));
vi.mock("@/lib/activity/activity", () => ({ record: async () => undefined }));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit }));
vi.mock("@/lib/deploy-service", () => ({ redeployForEnvScope }));
vi.mock("@/lib/deploy-project-access", () => ({ requireEnvScopeAccess }));
vi.mock("@/lib/deploy/variable-links", () => ({ variableLinks: async () => ({}) }));
vi.mock("@/lib/deploy/variable-referrers", () => ({ environmentReferrers }));
vi.mock("@/lib/env-var-service", () => ({
    setEnvVar,
    setEnvVarSecrecy,
    deleteEnvVar,
    envVarScope,
    listEnvVars,
    promoteEnvVar,
    revealEnvVar,
    sealedValue,
    sealEnvVar,
    setEnvVarGenerator
}));

const {
    saveEnvVarChangesAction,
    redeployEnvScopeAction,
    revealEnvScopeAction,
    promoteEnvVarAction,
    sealEnvVarAction,
    setEnvVarGeneratorAction
} = await import("@/app/(app)/apps/deploy/variable-actions");

const BASE = {
    scope: "application",
    scopeId: "app-1",
    set: [],
    secrecy: [],
    remove: [],
    redeploy: false
};

describe("saveEnvVarChangesAction", () => {
    beforeEach(() => {
        for (const mock of [
            requireEnvScopeAccess,
            redeployForEnvScope,
            setEnvVar,
            setEnvVarSecrecy,
            deleteEnvVar,
            envVarScope
        ]) {
            mock.mockReset();
        }
        requireEnvScopeAccess.mockResolvedValue({ ownerId: "owner-1", orgId: null });
        redeployForEnvScope.mockResolvedValue(undefined);
        envVarScope.mockImplementation(async (id: string) => ({
            scope: "application",
            scopeId: "app-1",
            key: `KEY_${id}`
        }));
    });

    it("saves without redeploying when a redeploy was not asked for", async () => {
        const result = await saveEnvVarChangesAction({
            ...BASE,
            set: [{ key: "PORT", value: "8080", isSecret: false }]
        });
        expect(result).toEqual({ saved: 1, redeployed: false });
        expect(setEnvVar).toHaveBeenCalledWith("application", "app-1", "owner-1", {
            key: "PORT",
            value: "8080",
            isSecret: false
        });
        expect(redeployForEnvScope).not.toHaveBeenCalled();
        expect(requireEnvScopeAccess).toHaveBeenCalledWith(
            "application",
            "app-1",
            "user-1",
            "variables.write"
        );
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
        expect(requireEnvScopeAccess).toHaveBeenCalledWith(
            "application",
            "app-1",
            "user-1",
            "deploy.run"
        );
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
        const result = await saveEnvVarChangesAction({
            ...BASE,
            set: [{ key: "9LIVES", value: "", isSecret: false }]
        });
        expect(result.error).toContain("Letters, digits and underscores");
        expect(requireEnvScopeAccess).not.toHaveBeenCalled();
    });
});

describe("redeployEnvScopeAction", () => {
    it("asks for the right to deploy", async () => {
        requireEnvScopeAccess.mockReset().mockResolvedValue({ ownerId: "owner-1", orgId: null });
        redeployForEnvScope.mockReset().mockResolvedValue(undefined);
        expect(await redeployEnvScopeAction({ scope: "environment", scopeId: "env-1" })).toEqual(
            {}
        );
        expect(requireEnvScopeAccess).toHaveBeenCalledWith(
            "environment",
            "env-1",
            "user-1",
            "deploy.run"
        );
        expect(redeployForEnvScope).toHaveBeenCalledWith(
            "environment",
            "env-1",
            "owner-1",
            "user-1"
        );
    });
});

describe("revealEnvScopeAction", () => {
    beforeEach(() => {
        for (const mock of [requireEnvScopeAccess, listEnvVars, revealEnvVar, recordDeployAudit])
            mock.mockReset();
        requireEnvScopeAccess.mockResolvedValue({
            ownerId: "owner-1",
            orgId: null,
            environmentId: "env-1"
        });
        listEnvVars.mockResolvedValue([
            { id: "v1", key: "DATABASE_URL", isSecret: true, value: null },
            { id: "v2", key: "NODE_ENV", isSecret: false, value: "production" }
        ]);
        revealEnvVar.mockResolvedValue("postgres://u:p@db/app");
    });

    it("hands every value over to somebody who may read them, and writes down which secrets were seen", async () => {
        const result = await revealEnvScopeAction({ scope: "application", scopeId: "app-1" });
        expect(result).toEqual({ values: { v1: "postgres://u:p@db/app", v2: "production" } });
        expect(requireEnvScopeAccess).toHaveBeenCalledWith(
            "application",
            "app-1",
            "user-1",
            "variables.read"
        );
        expect(revealEnvVar).toHaveBeenCalledTimes(1);
        expect(recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "deploy.variable.reveal",
                metadata: { keys: ["DATABASE_URL"] }
            })
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
        for (const mock of [
            requireEnvScopeAccess,
            listEnvVars,
            revealEnvVar,
            promoteEnvVar,
            setEnvVar,
            envVarScope,
            recordDeployAudit
        ])
            mock.mockReset();
        requireEnvScopeAccess.mockResolvedValue({
            ownerId: "owner-1",
            orgId: null,
            environmentId: "env-1"
        });
        envVarScope.mockResolvedValue({
            scope: "application",
            scopeId: "app-1",
            key: "STRIPE_KEY"
        });
        listEnvVars.mockImplementation(async (scope: string) =>
            scope === "application"
                ? [{ id: "v1", key: "STRIPE_KEY", isSecret: true, value: null }]
                : [{ id: "s1", key: "OTHER", isSecret: false, value: "x" }]
        );
        sealedValue.mockResolvedValue("sk_live_123");
        promoteEnvVar.mockResolvedValue(true);
    });

    it("moves the value to the environment's shared variables and points the service at it", async () => {
        expect(await promoteEnvVarAction({ id: "v1" })).toEqual({ key: "STRIPE_KEY" });
        expect(requireEnvScopeAccess).toHaveBeenCalledWith(
            "application",
            "app-1",
            "user-1",
            "variables.write"
        );
        expect(requireEnvScopeAccess).toHaveBeenCalledWith(
            "environment",
            "env-1",
            "user-1",
            "variables.write"
        );
        expect(promoteEnvVar).toHaveBeenCalledWith({
            serviceId: "app-1",
            serviceOwnerId: "owner-1",
            environmentId: "env-1",
            environmentOwnerId: "owner-1",
            key: "STRIPE_KEY",
            value: "sk_live_123",
            isSecret: true,
            sealed: false,
            generator: null
        });
        expect(setEnvVar).not.toHaveBeenCalled();
        expect(recordDeployAudit).toHaveBeenCalledTimes(2);
    });

    it("refuses when the environment already shares a variable by that name, and records nothing", async () => {
        promoteEnvVar.mockResolvedValue(false);
        const result = await promoteEnvVarAction({ id: "v1" });
        expect(result.error).toContain("STRIPE_KEY");
        expect(recordDeployAudit).not.toHaveBeenCalled();
    });

    it("only promotes a service's own variable", async () => {
        envVarScope.mockResolvedValue({
            scope: "environment",
            scopeId: "env-1",
            key: "STRIPE_KEY"
        });
        expect((await promoteEnvVarAction({ id: "v1" })).error).toBeTruthy();
        expect(promoteEnvVar).not.toHaveBeenCalled();
    });

    it("does not promote one that already points at a shared variable", async () => {
        listEnvVars.mockImplementation(async (scope: string) =>
            scope === "application"
                ? [
                      {
                          id: "v1",
                          key: "STRIPE_KEY",
                          isSecret: false,
                          value: "${{shared.STRIPE_KEY}}"
                      }
                  ]
                : []
        );
        sealedValue.mockResolvedValue("${{shared.STRIPE_KEY}}");
        expect((await promoteEnvVarAction({ id: "v1" })).error).toBeTruthy();
        expect(promoteEnvVar).not.toHaveBeenCalled();
    });
});

describe("sealing a variable", () => {
    beforeEach(() => {
        for (const mock of [requireEnvScopeAccess, envVarScope, sealEnvVar, recordDeployAudit])
            mock.mockReset();
        requireEnvScopeAccess.mockResolvedValue({ ownerId: "owner-1", orgId: null });
        envVarScope.mockResolvedValue({ scope: "application", scopeId: "app-1", key: "TOKEN" });
        sealEnvVar.mockResolvedValue(true);
    });

    it("seals with the right to edit the variables, and writes down which one by name", async () => {
        expect(await sealEnvVarAction({ id: "v1" })).toEqual({});
        expect(requireEnvScopeAccess).toHaveBeenCalledWith(
            "application",
            "app-1",
            "user-1",
            "variables.write"
        );
        expect(sealEnvVar).toHaveBeenCalledWith("v1", "owner-1");
        expect(recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "deploy.variable.seal",
                metadata: { key: "TOKEN" }
            })
        );
    });

    it("seals nothing for somebody who may not edit the variables", async () => {
        requireEnvScopeAccess.mockRejectedValue(new Error("You cannot change this service"));
        expect(await sealEnvVarAction({ id: "v1" })).toEqual({
            error: "You cannot change this service"
        });
        expect(sealEnvVar).not.toHaveBeenCalled();
    });

    it("leaves a sealed variable out of the raw editor's values", async () => {
        listEnvVars.mockResolvedValue([
            { id: "v1", key: "TOKEN", isSecret: true, value: null, sealed: true },
            { id: "v2", key: "PORT", isSecret: false, value: "80", sealed: false }
        ]);
        revealEnvVar.mockReset();
        const result = await revealEnvScopeAction({ scope: "application", scopeId: "app-1" });
        expect(result).toEqual({ values: { v2: "80" } });
        expect(revealEnvVar).not.toHaveBeenCalled();
    });
});

describe("a variable's generator", () => {
    beforeEach(() => {
        for (const mock of [requireEnvScopeAccess, envVarScope, setEnvVarGenerator])
            mock.mockReset();
        requireEnvScopeAccess.mockResolvedValue({ ownerId: "owner-1", orgId: null });
        envVarScope.mockResolvedValue({ scope: "environment", scopeId: "env-1", key: "PASS" });
    });

    it("saves a generator that reads, and replaces the value only when asked", async () => {
        expect(
            await setEnvVarGeneratorAction({
                id: "v1",
                generator: "${{ secret(16) }}",
                regenerate: false
            })
        ).toEqual({});
        expect(setEnvVarGenerator).toHaveBeenCalledWith(
            "v1",
            "owner-1",
            "${{ secret(16) }}",
            false
        );
    });

    it("refuses one that does not read, before touching anything", async () => {
        const result = await setEnvVarGeneratorAction({
            id: "v1",
            generator: "${{ secret(0) }}",
            regenerate: true
        });
        expect(result.error).toBeTruthy();
        expect(setEnvVarGenerator).not.toHaveBeenCalled();
    });
});

describe("rotating a value", () => {
    beforeEach(() => {
        for (const mock of [requireEnvScopeAccess, redeployForEnvScope, setEnvVar, envVarScope])
            mock.mockReset();
        requireEnvScopeAccess.mockResolvedValue({ ownerId: "owner-1", orgId: null });
        redeployForEnvScope.mockResolvedValue(undefined);
        environmentReferrers.mockReset();
        environmentReferrers.mockResolvedValue(["app-2", "app-3"]);
    });

    it("redeploys every service that reads the changed key along with this one", async () => {
        const result = await saveEnvVarChangesAction({
            ...BASE,
            set: [{ key: "API_KEY", value: "new", isSecret: true }],
            redeploy: true
        });
        expect(result).toEqual({ saved: 1, redeployed: true, referrers: 2 });
        expect(environmentReferrers).toHaveBeenCalledWith("app-1", ["API_KEY"]);
        await vi.waitFor(() => expect(redeployForEnvScope).toHaveBeenCalledTimes(3));
        expect(redeployForEnvScope).toHaveBeenCalledWith("application", "app-2", "owner-1", "user-1", {
            rotation: "app-1"
        });
    });

    it("redeploys none of them on a save without a redeploy", async () => {
        await saveEnvVarChangesAction({
            ...BASE,
            set: [{ key: "API_KEY", value: "new", isSecret: true }]
        });
        expect(environmentReferrers).not.toHaveBeenCalled();
        expect(redeployForEnvScope).not.toHaveBeenCalled();
    });
});
