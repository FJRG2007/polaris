/**
 * `plr projects` (GET /api/v1/deploy/projects) asks for every project's access
 * at once, beside the deploy statuses, rather than one project after another -
 * eight projects used to be eight access lookups in a row before the answer.
 * Held here by counting what is in flight before anything is answered.
 */

import { describe, expect, it, vi } from "vitest";

const PROJECTS = Array.from({ length: 8 }, (_, index) => ({
    id: `project-${index}`,
    name: `Project ${index}`,
    slug: `project-${index}`,
    environments: [
        {
            id: `env-${index}`,
            name: "production",
            slug: "production",
            isDefault: true,
            applications: [
                {
                    id: `app-${index}`,
                    name: "web",
                    slug: "web",
                    currentDeploymentId: `dep-${index}`
                }
            ]
        }
    ]
}));

/** Lookups that answer only when the test lets them. */
const pending: (() => void)[] = [];
const held = <T>(value: T) =>
    new Promise<T>((resolve) => {
        pending.push(() => resolve(value));
    });

const projectAccess = vi.fn((projectId: string) =>
    held({ projectId, role: "developer", environmentIds: null })
);
const statuses = vi.fn(() => held({ "app-0": "running" }));

vi.mock("@polaris/db", () => ({
    prisma: { project: { findMany: async () => PROJECTS } }
}));
vi.mock("@/lib/deploy-project-access", () => ({
    projectAccess: (projectId: string) => projectAccess(projectId),
    accessInEnvironment: () => true,
    visibleProjectIds: async () => PROJECTS.map((project) => project.id)
}));
vi.mock("@/lib/deploy-service", () => ({ getApplicationDeployStatuses: () => statuses() }));
vi.mock("@/lib/audit-service", () => ({ recordAudit: vi.fn() }));
vi.mock("@/lib/activity/activity", () => ({ record: async () => undefined }));

const { listProjects } = await import("@/lib/deploy/api/surface");

describe("listing the projects", () => {
    it("asks for every project's access and the statuses at once", async () => {
        const listing = listProjects({
            userId: "user-1",
            scopes: ["deploy.read"],
            keyId: "key-1",
            projectId: null,
            via: "api"
        });
        await vi.waitFor(() => expect(pending).toHaveLength(PROJECTS.length + 1));
        // Nothing has answered yet, and every lookup is already out.
        expect(projectAccess).toHaveBeenCalledTimes(PROJECTS.length);
        expect(statuses).toHaveBeenCalledTimes(1);

        for (const release of pending.splice(0)) release();
        const lines = await listing;
        expect(lines.map((line) => line.slug)).toEqual(PROJECTS.map((project) => project.slug));
        expect(lines[0]?.environments[0]?.services[0]?.status).toBe("running");
        expect(lines[1]?.environments[0]?.services[0]?.status).toBe("idle");
    });
});
