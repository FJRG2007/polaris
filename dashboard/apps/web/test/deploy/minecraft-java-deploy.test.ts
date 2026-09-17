/**
 * A Minecraft server whose release moved to another Java is started on that Java.
 *
 * A restart of the live release normally runs its kept image, but that image was
 * made from the Java the server ran before, so it is pulled again instead. The
 * service keeps the new image only once the deploy has been accepted.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";

const dataDir = await mkdtemp(join(tmpdir(), "polaris-minecraft-java-"));

const OWNER = "owner-1";
const APP = "019f8506-683f-7dd0-9c13-1e9ee9237fe4";
const KEPT = "polaris-release/games-mc:0123456789ab";

const { app, refs, updateApp, findUniqueDeployment, deployed } = vi.hoisted(() => ({
    app: {
        id: "019f8506-683f-7dd0-9c13-1e9ee9237fe4",
        slug: "mc",
        name: "mc",
        environmentId: "env-1",
        sourceType: "image",
        sourceConfig: JSON.stringify({ imageRef: "itzg/minecraft-server:java21" }),
        buildConfig: "{}",
        edgeConfig: null,
        healthcheck: null,
        publishPort: true,
        keepReleases: false,
        replicas: 1,
        cpuLimit: null,
        memoryLimitMb: null,
        currentDeploymentId: "dep-0" as string | null,
        environment: {
            id: "env-1",
            name: "production",
            branch: null,
            networkMode: null,
            project: { id: "project-1", slug: "games", name: "Games", ownerId: "owner-1" }
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
    refs: { env: {} as Record<string, string>, unresolved: [] as string[] },
    updateApp: vi.fn(async () => undefined),
    findUniqueDeployment: vi.fn(),
    deployed: [] as Array<{ build: Record<string, unknown> }>
}));

vi.mock("@polaris/config", () => ({ loadEnv: () => ({ POLARIS_DATA_DIR: dataDir }) }));
vi.mock("@polaris/db", () => ({
    prisma: {
        application: {
            findFirst: vi.fn(async () => app),
            findUnique: vi.fn(async ({ select }: { select?: Record<string, boolean> }) =>
                select?.sourceConfig ? { sourceConfig: app.sourceConfig } : null
            ),
            update: updateApp
        },
        envVar: { findMany: vi.fn(async () => []) },
        environment: { findUnique: vi.fn(async () => null) },
        installedApp: { findFirst: vi.fn(async () => null) },
        deployment: {
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
                id: "dep-1",
                ...data
            })),
            findFirst: vi.fn(async () => null),
            findUnique: findUniqueDeployment,
            update: vi.fn(async () => undefined)
        }
    }
}));
vi.mock("@/lib/deploy-audit", () => ({ recordDeployAudit: vi.fn(async () => undefined) }));
vi.mock("@/lib/deploy/references", () => ({
    resolveServiceReferences: async () => ({
        env: { ...refs.env },
        unresolved: [...refs.unresolved]
    })
}));
vi.mock("@/lib/deploy/runtime", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/lib/deploy/runtime")>()),
    getPorts: async () => ({ dispose: () => undefined }),
    getDriver: () => ({
        deployApplication: async (plan: { build: Record<string, unknown> }) => {
            deployed.push(plan);
            throw new Error("stop here");
        }
    })
}));
vi.mock("@/lib/registry-credential-service", () => ({ resolveRegistryLogin: async () => null }));
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

const { deployApplication, restartFromKeptImage } = await import("@/lib/deploy-service");

async function planOfNextRun(): Promise<{ build: Record<string, unknown> }> {
    await vi.waitFor(() => expect(deployed).toHaveLength(1));
    return deployed[0]!;
}

beforeEach(() => {
    deployed.length = 0;
    updateApp.mockClear();
    refs.unresolved = [];
    findUniqueDeployment
        .mockReset()
        .mockImplementation(async ({ where }: { where: { id: string } }) =>
            where.id === "dep-0"
                ? {
                      id: "dep-0",
                      status: "running",
                      imageTag: KEPT,
                      imageKept: true,
                      commitSha: null,
                      commitMessage: null,
                      authorName: null,
                      authorAvatarUrl: null
                  }
                : { id: where.id, status: "queued" }
        );
});

describe("a Minecraft server restarted with its variables changed", () => {
    it("pulls the Java its release now needs instead of running the kept image", async () => {
        refs.env = { VERSION: "LATEST" };
        await restartFromKeptImage(APP, OWNER, "member-1", "variables");
        const plan = await planOfNextRun();
        expect(plan.build.imageRef).toBe("itzg/minecraft-server:java25");
        expect(plan.build.rollbackImage).toBeUndefined();
        expect(updateApp).toHaveBeenCalledWith({
            where: { id: APP },
            data: { sourceConfig: JSON.stringify({ imageRef: "itzg/minecraft-server:java25" }) }
        });
    });

    it("runs the kept image when the Java has not changed", async () => {
        refs.env = { VERSION: "1.21.4" };
        await restartFromKeptImage(APP, OWNER, "member-1", "variables");
        const plan = await planOfNextRun();
        expect(plan.build.rollbackImage).toBe(KEPT);
        expect(updateApp).not.toHaveBeenCalled();
    });
});

describe("the image kept on the service", () => {
    it("is left alone when the deploy is refused", async () => {
        refs.env = { VERSION: "LATEST" };
        refs.unresolved = ["${{postgres.DATABASE_URL}}"];
        await expect(deployApplication(APP, OWNER, "member-1")).rejects.toThrow(
            "refers to nothing"
        );
        expect(updateApp).not.toHaveBeenCalled();
    });
});
