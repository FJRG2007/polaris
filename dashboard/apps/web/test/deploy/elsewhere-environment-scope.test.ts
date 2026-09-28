/**
 * The Elsewhere board holds an access limited to some environments to them.
 *
 * A project access can stop at development. Moving a service out reads every
 * secret it runs with, hands them to a provider account the caller linked and
 * stops it here - so the service being moved has to be in an environment the
 * access reaches, not only the environment the new row is filed under. The rows
 * already on the board are held to the environment they are in the same way.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const PROJECT = "018f2b7a-0000-7000-8000-0000000000p1";
const DEV = "018f2b7a-0000-7000-8000-0000000000d1";
const PROD = "018f2b7a-0000-7000-8000-0000000000f1";
const PROD_APP = "018f2b7a-0000-7000-8000-0000000000a1";
const PROD_ROW = "018f2b7a-0000-7000-8000-0000000000b1";
const CONNECTION = "018f2b7a-0000-7000-8000-0000000000c1";

/** A developer on the project, limited to development. */
const devAccess = {
    projectId: PROJECT,
    ownerId: "owner",
    orgId: null,
    role: "developer",
    isOwner: false,
    capabilities: [
        "project.read",
        "service.create",
        "service.configure",
        "service.delete",
        "deploy.run",
        "variables.read",
        "variables.write"
    ],
    environmentIds: [DEV]
};

const environmentOf: Record<string, string> = { [PROD_APP]: PROD, [PROD_ROW]: PROD };

const moveOut = vi.fn(async () => ({ service: { provider: "vercel" }, copied: 1, stopped: true }));
const moveHome = vi.fn(async () => ({ applicationId: "new", copied: 1 }));
const removeExternalService = vi.fn(async () => undefined);
const addExternalService = vi.fn(async () => ({ id: "row" }));

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }));
vi.mock("@/lib/session", () => ({ requirePermission: async () => ({ id: "dev", isAdmin: false }) }));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit: async () => undefined }));
vi.mock("@/lib/connections/store", () => ({ listConnections: async () => [] }));
vi.mock("@/lib/deploy-target-service", () => ({ listDeployTargets: async () => [] }));
vi.mock("@/lib/deploy/migrate", () => ({
    moveOut: (...args: unknown[]) => moveOut(...(args as [])),
    moveHome: (...args: unknown[]) => moveHome(...(args as [])),
    moveOutPlan: async () => ({ variableKeys: [] }),
    moveHomePlan: async () => ({ variableKeys: [] })
}));
vi.mock("@/lib/deploy/external-services", () => ({
    externalServiceEnvironment: async (_projectId: string, id: string) => environmentOf[id] ?? DEV,
    addExternalService: (...args: unknown[]) => addExternalService(...(args as [])),
    removeExternalService: (...args: unknown[]) => removeExternalService(...(args as [])),
    refreshExternalService: async () => ({}),
    deployExternalService: async () => ({}),
    renameExternalService: async () => ({}),
    providerChoices: async () => []
}));
vi.mock("@/lib/deploy-project-access", () => {
    const inEnvironment = (access: typeof devAccess, environmentId: string) =>
        access.environmentIds === null || access.environmentIds.includes(environmentId);
    return {
        accessCan: (access: typeof devAccess, capability: string) => access.capabilities.includes(capability),
        accessInEnvironment: inEnvironment,
        requireProjectAccess: async () => devAccess,
        requireEnvironmentAccess: async (environmentId: string) => {
            if (!inEnvironment(devAccess, environmentId)) throw new Error("Environment not found");
            return devAccess;
        },
        requireApplicationAccess: async (applicationId: string) => {
            if (!inEnvironment(devAccess, environmentOf[applicationId] ?? DEV)) throw new Error("Service not found");
            return { ...devAccess, environmentId: environmentOf[applicationId] ?? DEV };
        }
    };
});

const actions = await import("../../src/app/(app)/apps/deploy/external-actions");

beforeEach(() => {
    vi.clearAllMocks();
});

describe("moving a service out", () => {
    it("refuses a production service to an access limited to development", async () => {
        const result = await actions.moveOutAction(PROJECT, PROD_APP, {
            connectionId: CONNECTION,
            externalId: "their-project",
            name: "x",
            environmentId: DEV,
            copyVariables: true,
            stopHere: true,
            releaseThere: false
        });
        expect(result.error).toBeTruthy();
        expect(moveOut).not.toHaveBeenCalled();
    });
});

describe("rows already on the board", () => {
    it("refuses bringing home, and removing, a row in an environment the access does not reach", async () => {
        const home = await actions.moveHomeAction(PROJECT, PROD_ROW, {
            environmentId: DEV,
            targetId: CONNECTION,
            name: "x",
            repoUrl: "https://example.com/r.git",
            copyVariables: true,
            deployNow: false
        });
        const removed = await actions.removeExternalServiceAction(PROJECT, PROD_ROW);
        expect(home.error).toBeTruthy();
        expect(removed.error).toBeTruthy();
        expect(moveHome).not.toHaveBeenCalled();
        expect(removeExternalService).not.toHaveBeenCalled();
    });

    it("refuses filing a new row into an environment the access does not reach", async () => {
        const result = await actions.addExternalServiceAction(PROJECT, {
            environmentId: PROD,
            connectionId: CONNECTION,
            name: "x",
            externalId: "their-project"
        });
        expect(result.error).toBeTruthy();
        expect(addExternalService).not.toHaveBeenCalled();
    });
});
