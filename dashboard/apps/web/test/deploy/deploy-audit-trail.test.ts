/**
 * Every application deploy is on the audit trail, whatever started it.
 *
 * There are more than twenty ways into `deployApplication` and it is the one
 * writing the entry, so none of them can forget to. The entry credits whoever
 * asked - never the project's owner standing in for somebody who did not, which
 * is what a push, the autoscaler or a sweep would otherwise read as.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = await mkdtemp(join(tmpdir(), "polaris-deploy-audit-"));

const OWNER = "owner-1";
const APP = "019f8506-683f-7dd0-9c13-1e9ee9237fe3";

const { app, create, findFirstDeployment, findUniqueDeployment, recordDeployAudit } = vi.hoisted(
    () => ({
        app: {
            id: "019f8506-683f-7dd0-9c13-1e9ee9237fe3",
            slug: "web",
            name: "web",
            environmentId: "env-1",
            sourceType: "image",
            sourceConfig: JSON.stringify({ imageRef: "nginx:alpine" }),
            buildConfig: "{}",
            edgeConfig: null,
            healthcheck: null,
            publishPort: true,
            keepReleases: false,
            replicas: 1,
            cpuLimit: null,
            memoryLimitMb: null,
            currentDeploymentId: null as string | null,
            environment: {
                id: "env-1",
                name: "production",
                branch: null,
                networkMode: null,
                project: { id: "project-1", slug: "shop", name: "Shop", ownerId: "owner-1" }
            },
            target: {
                id: "target-1",
                kind: "local",
                hostId: null,
                runtime: "compose",
                name: "Local",
                proxyNetwork: "polaris"
            },
            volumes: [],
            domains: []
        },
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
            id: "dep-1",
            ...data
        })),
        findFirstDeployment: vi.fn(async () => null as Record<string, unknown> | null),
        // Nothing is found for the queued run, so it ends before reaching a runtime.
        findUniqueDeployment: vi.fn(async () => null),
        recordDeployAudit: vi.fn(async () => undefined)
    })
);

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DATA_DIR: dataDir }) }));
vi.mock("@polaris/db", () => ({
    prisma: {
        application: { findFirst: vi.fn(async () => app), findUnique: vi.fn(async () => null) },
        envVar: { findMany: vi.fn(async () => []) },
        environment: { findUnique: vi.fn(async () => null) },
        installedApp: { findFirst: vi.fn(async () => null) },
        deployment: { create, findFirst: findFirstDeployment, findUnique: findUniqueDeployment }
    }
}));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit }));
vi.mock("@/lib/deploy/references", () => ({
    resolveServiceReferences: async (env: Record<string, string>) => ({
        env: { ...env },
        unresolved: []
    })
}));
vi.mock("@/lib/waf-service", () => ({
    resolveWaf: async () => ({
        allowLists: [],
        deny: [],
        presets: [],
        rules: [],
        requireLogin: false,
        browserIntegrity: false,
        sqlInjectionProtection: false,
        xssProtection: false
    }),
    resolveWafBatch: async () => new Map()
}));
vi.mock("@/lib/deploy/edge-state", () => ({
    challengeActive: async () => false,
    floodedServices: async () => new Map()
}));
vi.mock("@/lib/deploy/service-networks", () => ({
    hasTunnel: async () => false,
    networksForService: () => []
}));
vi.mock("@/lib/deploy/github-deployment", () => ({
    announceDeployQueued: vi.fn(async () => undefined),
    announceDeployStarted: vi.fn(async () => undefined),
    announceDeployFinished: vi.fn(async () => undefined)
}));

const { deployApplication, restartFromKeptImage, rollbackToDeployment } = await import(
    "@/lib/deploy-service"
);

beforeEach(() => {
    create.mockClear();
    findUniqueDeployment.mockReset().mockResolvedValue(null);
    recordDeployAudit.mockClear();
    app.currentDeploymentId = null;
});

describe("the audit entry a deploy writes", () => {
    it("is written once, crediting who asked, with the deployment and what started it", async () => {
        await deployApplication(APP, OWNER, "member-1", {
            trigger: "upload",
            audit: { via: "api", keyId: "key-1" }
        });
        expect(recordDeployAudit).toHaveBeenCalledTimes(1);
        expect(recordDeployAudit).toHaveBeenCalledWith({
            actorId: "member-1",
            action: "deploy.app.deploy",
            targetType: "application",
            targetId: APP,
            metadata: { deploymentId: "dep-1", trigger: "upload", via: "api", keyId: "key-1" }
        });
        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({ triggeredById: "member-1" })
        });
    });

    it("credits nobody for a deploy nobody asked for, while the history still names the owner", async () => {
        await deployApplication(APP, OWNER, null, { trigger: "push" });
        expect(recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                actorId: null,
                metadata: { deploymentId: "dep-1", trigger: "push" }
            })
        );
        expect(create).toHaveBeenCalledWith({
            data: expect.objectContaining({ triggeredById: OWNER })
        });
    });

    it("carries the actor and the key through a restart of the live release", async () => {
        await restartFromKeptImage(APP, OWNER, "member-1", "variables", {
            via: "mcp",
            keyId: "key-2"
        });
        expect(recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                actorId: "member-1",
                metadata: {
                    deploymentId: "dep-1",
                    trigger: "variables",
                    via: "mcp",
                    keyId: "key-2"
                }
            })
        );
    });

    it("carries the key through a rollback", async () => {
        const release = {
            id: "dep-0",
            deployableId: APP,
            status: "removed",
            imageTag: "polaris-release/shop-web:0123456789ab",
            imageKept: true,
            commitSha: "abcdef1",
            commitMessage: "Earlier",
            authorName: null,
            authorAvatarUrl: null
        };
        findFirstDeployment.mockResolvedValueOnce(release);
        await rollbackToDeployment("dep-0", OWNER, "member-1", { via: "api", keyId: "key-1" });
        expect(recordDeployAudit).toHaveBeenCalledWith(
            expect.objectContaining({
                actorId: "member-1",
                metadata: { deploymentId: "dep-1", trigger: "rollback", via: "api", keyId: "key-1" }
            })
        );
    });
});
