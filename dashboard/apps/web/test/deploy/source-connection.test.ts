/**
 * Disconnecting a service's repository leaves what is running alone and only
 * stops pushes; changing it re-points the next deploy and the pushes it hears.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    app: {} as Record<string, unknown>,
    updates: [] as Record<string, unknown>[],
    lines: [] as Record<string, unknown>[],
    dropped: [] as string[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        application: {
            findFirst: vi.fn(async () => state.app),
            update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                state.updates.push(data);
                Object.assign(state.app, data);
                return state.app;
            })
        }
    }
}));
vi.mock("@/lib/activity/activity", () => ({
    record: vi.fn(async (entry: Record<string, unknown>) => {
        state.lines.push(entry);
    })
}));
vi.mock("@/lib/deploy/ci-wait", () => ({
    dropCiWait: vi.fn(async (id: string) => {
        state.dropped.push(id);
    })
}));

const { disconnectSource, repointSource, repointSourceSchema } = await import(
    "@/lib/deploy/source-connection"
);

beforeEach(() => {
    state.app = {
        id: "app-1",
        sourceType: "dockerfile",
        sourceConfig: JSON.stringify({
            repoUrl: "https://github.com/acme/web",
            provider: "github",
            branch: "main",
            rootDirectory: "apps/web",
            dockerfilePath: "Dockerfile"
        }),
        deployBranch: "main",
        autoDeploy: true,
        lastDeployedSha: "abc",
        currentDeploymentId: "dep-1",
        environment: { branch: null }
    };
    state.updates = [];
    state.lines = [];
    state.dropped = [];
});

describe("disconnecting a repository", () => {
    it("keeps the deployment running and stops pushes", async () => {
        expect(await disconnectSource("app-1", "owner-1", "user-1")).toBe("acme/web");
        expect(state.updates).toHaveLength(1);
        const data = state.updates[0] ?? {};
        // Nothing that points at the running deployment is written.
        expect(data).not.toHaveProperty("currentDeploymentId");
        expect(state.app.currentDeploymentId).toBe("dep-1");
        expect(data.autoDeploy).toBe(false);
        expect(JSON.parse(String(data.sourceConfig))).toEqual({
            rootDirectory: "apps/web",
            dockerfilePath: "Dockerfile"
        });
        expect(state.dropped).toEqual(["app-1"]);
        expect(state.lines[0]).toMatchObject({ action: "source-disconnected", fromValue: "acme/web" });
    });

    it("writes nothing for a service with no repository", async () => {
        state.app.sourceConfig = "{}";
        expect(await disconnectSource("app-1", "owner-1", "user-1")).toBeNull();
        expect(state.updates).toHaveLength(0);
    });
});

describe("changing the repository", () => {
    it("re-points the source and the branch pushes are heard on", async () => {
        await repointSource("app-1", "owner-1", "user-1", { repoFullName: "acme/api", branch: "release" });
        const data = state.updates[0] ?? {};
        expect(JSON.parse(String(data.sourceConfig))).toMatchObject({
            repoUrl: "https://github.com/acme/api",
            provider: "github",
            branch: "release",
            rootDirectory: "apps/web"
        });
        expect(data.deployBranch).toBe("release");
        // The old repository's last commit means nothing in the new one.
        expect(data.lastDeployedSha).toBeNull();
        expect(state.app.currentDeploymentId).toBe("dep-1");
        expect(state.dropped).toEqual(["app-1"]);
        expect(state.lines[0]).toMatchObject({
            action: "source-changed",
            fromValue: "acme/web",
            toValue: "acme/api@release"
        });
    });

    it("refuses a service that runs an image", async () => {
        state.app.sourceType = "image";
        await expect(
            repointSource("app-1", "owner-1", "user-1", { repoFullName: "acme/api", branch: "" })
        ).rejects.toThrow();
    });

    it("accepts only a repository name and a git branch name", () => {
        expect(repointSourceSchema.safeParse({ repoFullName: "acme/api", branch: "feat/x" }).success).toBe(true);
        expect(repointSourceSchema.safeParse({ repoFullName: "acme/api", branch: "" }).success).toBe(true);
        expect(repointSourceSchema.safeParse({ repoFullName: "acme", branch: "" }).success).toBe(false);
        expect(repointSourceSchema.safeParse({ repoFullName: "acme/api", branch: "a b" }).success).toBe(false);
        expect(repointSourceSchema.safeParse({ repoFullName: "acme/api", branch: "a..b" }).success).toBe(false);
        expect(repointSourceSchema.safeParse({ repoFullName: "../x/y", branch: "" }).success).toBe(false);
    });
});
