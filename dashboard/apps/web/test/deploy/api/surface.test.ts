/**
 * The programmatic Deploy surface: what a key may reach, and what is recorded.
 *
 * Every test here is about a gate, because the surface does nothing of its own -
 * it calls the same service functions the dashboard does. What it adds is the
 * key's scope, the project capability, the confinement of a project token, and
 * the audit row; if any of those is missed, a key reaches more than its owner
 * could by clicking.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const OWNER = "owner-1";
const USER = "user-1";
const PROJECT_A = "11111111-1111-4111-8111-111111111111";
const PROJECT_B = "22222222-2222-4222-8222-222222222222";
const APP = "33333333-3333-4333-8333-333333333333";

const access = (projectId = PROJECT_A) => ({
    projectId,
    ownerId: OWNER,
    role: "developer",
    isOwner: false,
    capabilities: [],
    environmentIds: null,
    environmentId: "env-1"
});

const requireApplicationAccess = vi.fn();
const deployApplication = vi.fn();
const rollbackToDeployment = vi.fn();
const recordAudit = vi.fn();
const revealEnvVar = vi.fn();
const setEnvVar = vi.fn();
const applications = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        application: { findMany: (...args: unknown[]) => applications(...args) },
        envVar: { findUnique: async () => ({ key: "DATABASE_URL" }) },
        project: { findMany: async () => [] }
    }
}));

vi.mock("@/lib/deploy-project-access", () => ({
    requireApplicationAccess: (...args: unknown[]) => requireApplicationAccess(...args),
    requireDeploymentAccess: vi.fn(),
    requireDomainAccess: vi.fn(),
    requireEnvironmentAccess: vi.fn(),
    projectAccess: vi.fn(),
    accessInEnvironment: () => true,
    visibleProjectIds: async () => [PROJECT_A, PROJECT_B]
}));

vi.mock("@/lib/deploy-service", () => ({
    deployApplication: (...args: unknown[]) => deployApplication(...args),
    rollbackToDeployment: (...args: unknown[]) => rollbackToDeployment(...args),
    ensureApplicationDomain: async () => undefined,
    redeployForEnvScope: async () => undefined,
    getApplicationDeployStatuses: async () => ({})
}));

vi.mock("@/lib/audit-service", () => ({
    recordAudit: (...args: unknown[]) => recordAudit(...args)
}));
vi.mock("@/lib/activity/activity", () => ({ record: async () => undefined }));
vi.mock("@/lib/domain-dns", () => ({ provisionHostnameDns: async () => null }));
vi.mock("@/lib/env-var-service", () => ({
    envVarScope: async () => ({ scope: "application", scopeId: APP }),
    revealEnvVar: (...args: unknown[]) => revealEnvVar(...args),
    setEnvVar: (...args: unknown[]) => setEnvVar(...args),
    listEnvVars: async () => [],
    setEnvVars: async () => 0,
    deleteEnvVar: async () => null,
    parseDotEnv: () => []
}));

const surface = await import("@/lib/deploy/api/surface");
const { DeployApiRefusal } = await import("@/lib/deploy/api/refusal");

type Caller = Parameters<typeof surface.deploy>[0];

function caller(scopes: string[], projectId: string | null = null): Caller {
    return {
        userId: USER,
        scopes: scopes as Caller["scopes"],
        keyId: "key-1",
        projectId,
        via: "api"
    };
}

async function refusedWith(run: () => Promise<unknown>): Promise<number> {
    try {
        await run();
    } catch (caught) {
        if (caught instanceof DeployApiRefusal) return caught.status;
        throw caught;
    }
    throw new Error("expected a refusal");
}

beforeEach(() => {
    vi.clearAllMocks();
    requireApplicationAccess.mockResolvedValue(access());
    deployApplication.mockResolvedValue("dep-1");
    applications.mockResolvedValue([]);
});

describe("the key's scope", () => {
    it("refuses a deploy from a key that may only read, before touching the project", async () => {
        expect(await refusedWith(() => surface.deploy(caller(["deploy.read"]), APP))).toBe(403);
        expect(requireApplicationAccess).not.toHaveBeenCalled();
        expect(deployApplication).not.toHaveBeenCalled();
    });

    it("refuses to reveal a secret to a key that may only read", async () => {
        expect(
            await refusedWith(() => surface.revealVariable(caller(["deploy.read"]), "var-1"))
        ).toBe(403);
        expect(revealEnvVar).not.toHaveBeenCalled();
    });
});

describe("the project capability", () => {
    it("asks for the capability the dashboard asks for, and acts as the project's owner", async () => {
        await surface.deploy(caller(["deploy.manage"]), APP);
        expect(requireApplicationAccess).toHaveBeenCalledWith(APP, USER, "deploy.run");
        expect(deployApplication).toHaveBeenCalledWith(APP, OWNER, USER, expect.anything());
    });

    it("answers a project the key cannot reach with a plain 404", async () => {
        requireApplicationAccess.mockRejectedValue(new Error("Service not found"));
        expect(await refusedWith(() => surface.deploy(caller(["deploy.manage"]), APP))).toBe(404);
        expect(deployApplication).not.toHaveBeenCalled();
    });
});

describe("a project token", () => {
    it("reaches nothing outside the project it was minted from", async () => {
        requireApplicationAccess.mockResolvedValue(access(PROJECT_B));
        expect(
            await refusedWith(() => surface.deploy(caller(["deploy.manage"], PROJECT_A), APP))
        ).toBe(404);
        expect(deployApplication).not.toHaveBeenCalled();
    });

    it("works inside its own project", async () => {
        const { deploymentId } = await surface.deploy(caller(["deploy.manage"], PROJECT_A), APP);
        expect(deploymentId).toBe("dep-1");
    });
});

describe("naming a service", () => {
    const row = (id: string, service: string, environment: string, isDefault: boolean) => ({
        id,
        name: service,
        slug: service,
        environment: {
            name: environment,
            slug: environment,
            isDefault,
            project: { name: "Shop", slug: "shop" }
        }
    });

    it("reads project/service as the project's default environment", async () => {
        applications.mockResolvedValue([
            row("app-prod", "api", "production", true),
            row("app-stage", "api", "staging", false)
        ]);
        await surface.deploy(caller(["deploy.manage"]), "shop/api");
        expect(requireApplicationAccess).toHaveBeenCalledWith("app-prod", USER, "deploy.run");
    });

    it("reads project/environment/service as that environment, in any case", async () => {
        applications.mockResolvedValue([
            row("app-prod", "api", "production", true),
            row("app-stage", "api", "staging", false)
        ]);
        await surface.deploy(caller(["deploy.manage"]), "Shop/STAGING/Api");
        expect(requireApplicationAccess).toHaveBeenCalledWith("app-stage", USER, "deploy.run");
    });

    it("refuses a name that matches two services rather than picking one", async () => {
        applications.mockResolvedValue([
            row("app-1", "api", "production", true),
            { ...row("app-2", "worker", "production", true), name: "api" }
        ]);
        expect(await refusedWith(() => surface.deploy(caller(["deploy.manage"]), "shop/api"))).toBe(
            409
        );
        expect(deployApplication).not.toHaveBeenCalled();
    });

    it("says so when nothing this key can see has that name", async () => {
        expect(await refusedWith(() => surface.deploy(caller(["deploy.manage"]), "shop/api"))).toBe(
            404
        );
    });

    it("only searches the token's own project", async () => {
        await refusedWith(() => surface.deploy(caller(["deploy.manage"], PROJECT_A), "shop/api"));
        expect(applications).toHaveBeenCalledWith(
            expect.objectContaining({
                where: { environment: { projectId: { in: [PROJECT_A] } } }
            })
        );
    });
});

describe("what is recorded", () => {
    it("hands the key and the surface to the deploy's own audit entry", async () => {
        // The deploy writes its audit entry itself, whatever started it; the API
        // only says who asked.
        await surface.deploy(caller(["deploy.manage"]), APP);
        expect(deployApplication).toHaveBeenCalledWith(APP, OWNER, USER, {
            audit: { via: "api", keyId: "key-1" }
        });
    });

    it("audits a variable by its name and never its value", async () => {
        await surface.setVariable(
            caller(["deploy.manage"]),
            { kind: "service", ref: APP },
            { key: "API_TOKEN", value: "s3cret-value", secret: true }
        );
        const event = recordAudit.mock.calls[0]?.[0] as { metadata: Record<string, unknown> };
        expect(event.metadata.key).toBe("API_TOKEN");
        expect(JSON.stringify(event)).not.toContain("s3cret-value");
    });

    it("audits every reveal, with the variable's name, and needs the read capability", async () => {
        revealEnvVar.mockResolvedValue("postgres://...");
        const revealed = await surface.revealVariable(caller(["deploy.manage"]), "var-1");
        expect(revealed.key).toBe("DATABASE_URL");
        expect(requireApplicationAccess).toHaveBeenCalledWith(APP, USER, "variables.read");
        const event = recordAudit.mock.calls[0]?.[0] as {
            action: string;
            metadata: Record<string, unknown>;
        };
        expect(event.action).toBe("deploy.variable.reveal");
        expect(event.metadata.key).toBe("DATABASE_URL");
        expect(JSON.stringify(event)).not.toContain("postgres://");
    });
});

describe("rolling back", () => {
    const EARLIER = "44444444-4444-4444-8444-444444444444";

    it("asks for the capability a deploy needs and rolls back as the project's owner", async () => {
        const deployments = await import("@/lib/deploy-project-access");
        vi.mocked(deployments.requireDeploymentAccess).mockResolvedValue(access());
        rollbackToDeployment.mockResolvedValue({
            deploymentId: "dep-2",
            applicationId: APP,
            commitSha: "abcdef1234"
        });
        const result = await surface.rollback(caller(["deploy.manage"]), EARLIER);
        expect(deployments.requireDeploymentAccess).toHaveBeenCalledWith(
            EARLIER,
            USER,
            "deploy.run"
        );
        expect(rollbackToDeployment).toHaveBeenCalledWith(EARLIER, OWNER, USER, {
            via: "api",
            keyId: "key-1"
        });
        expect(result).toEqual({ deploymentId: "dep-2", commitSha: "abcdef1234" });
        expect(recordAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                action: "deploy.app.rollback",
                metadata: expect.objectContaining({
                    from: EARLIER,
                    deploymentId: "dep-2",
                    keyId: "key-1"
                })
            })
        );
    });

    it("keeps a project token out of another project's releases", async () => {
        const deployments = await import("@/lib/deploy-project-access");
        vi.mocked(deployments.requireDeploymentAccess).mockResolvedValue(access(PROJECT_B));
        expect(
            await refusedWith(() => surface.rollback(caller(["deploy.manage"], PROJECT_A), EARLIER))
        ).toBe(404);
        expect(rollbackToDeployment).not.toHaveBeenCalled();
    });

    it("refuses a key that may only read", async () => {
        expect(await refusedWith(() => surface.rollback(caller(["deploy.read"]), EARLIER))).toBe(
            403
        );
        expect(rollbackToDeployment).not.toHaveBeenCalled();
    });
});
