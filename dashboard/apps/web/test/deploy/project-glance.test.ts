/**
 * The project frame's glance: which services need a look and why, the newest
 * deploy of an environment across its services, and every address it answers on.
 * One definition feeds the section dot, the service tabs and the summary line,
 * so this is where "does this service need a look" is pinned.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const deploymentFindMany = vi.fn();
const domainFindMany = vi.fn();
const cronFindMany = vi.fn();
const settingFindMany = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        deployment: { findMany: deploymentFindMany },
        domain: { findMany: domainFindMany },
        serviceCron: { findMany: cronFindMany },
        setting: { findMany: settingFindMany }
    }
}));
vi.mock("../../src/lib/deploy-project-access", () => ({ projectAccess: async () => null }));

const { projectGlance, serviceAttention } = await import("../../src/lib/deploy/project-glance");
const { needsAttention } = await import("../../src/lib/deploy/attention");

describe("serviceAttention", () => {
    beforeEach(() => {
        deploymentFindMany.mockReset().mockResolvedValue([]);
        domainFindMany.mockReset().mockResolvedValue([]);
        cronFindMany.mockReset().mockResolvedValue([]);
    });

    it("flags a failed newest deploy, a down address and a failing job, each on its own service", async () => {
        deploymentFindMany.mockResolvedValue([
            { deployableId: "web", status: "failed" },
            { deployableId: "api", status: "running" }
        ]);
        domainFindMany.mockResolvedValue([{ applicationId: "api" }]);
        cronFindMany.mockResolvedValue([{ applicationId: "worker" }]);
        const result = await serviceAttention(["web", "api", "worker", "idle"]);
        expect(result.get("web")).toEqual({
            deployFailed: true,
            domainDown: false,
            cronFailing: false
        });
        expect(result.get("api")).toEqual({
            deployFailed: false,
            domainDown: true,
            cronFailing: false
        });
        expect(result.get("worker")).toEqual({
            deployFailed: false,
            domainDown: false,
            cronFailing: true
        });
        expect(needsAttention(result.get("idle"))).toBe(false);
    });

    it("asks only for the newest deployment of each service, and only enabled, non-release names", async () => {
        await serviceAttention(["web"]);
        expect(deploymentFindMany.mock.calls[0]?.[0]).toMatchObject({
            orderBy: { createdAt: "desc" },
            distinct: ["deployableId"]
        });
        expect(domainFindMany.mock.calls[0]?.[0].where).toMatchObject({
            enabled: true,
            kind: { not: "release" },
            healthStatus: "down"
        });
        expect(cronFindMany.mock.calls[0]?.[0].where).toMatchObject({ enabled: true });
    });

    it("does not query for no services", async () => {
        expect((await serviceAttention([])).size).toBe(0);
        expect(deploymentFindMany).not.toHaveBeenCalled();
    });
});

describe("projectGlance", () => {
    beforeEach(() => {
        deploymentFindMany.mockReset();
        domainFindMany.mockReset();
        cronFindMany.mockReset().mockResolvedValue([]);
        settingFindMany.mockReset().mockResolvedValue([]);
    });

    it("keeps each environment's addresses, newest deploy and attention to itself", async () => {
        domainFindMany.mockImplementation(async (query: { where: { healthStatus?: string } }) =>
            query.where.healthStatus === "down"
                ? []
                : [
                      {
                          id: "d1",
                          applicationId: "web",
                          hostname: "web.example.test",
                          kind: "custom",
                          enabled: true,
                          healthStatus: "up"
                      },
                      {
                          id: "d2",
                          applicationId: "dev-web",
                          hostname: "dev.example.test",
                          kind: "auto",
                          enabled: true,
                          healthStatus: "unknown"
                      }
                  ]
        );
        deploymentFindMany.mockResolvedValue([
            { deployableId: "api", status: "failed", createdAt: new Date("2026-09-10T10:00:00Z") },
            { deployableId: "web", status: "running", createdAt: new Date("2026-09-10T09:00:00Z") },
            {
                deployableId: "dev-web",
                status: "deploying",
                createdAt: new Date("2026-09-10T08:00:00Z")
            }
        ]);

        const glance = await projectGlance([
            {
                id: "prod",
                applications: [
                    { id: "web", name: "Web" },
                    { id: "api", name: "API" }
                ]
            },
            { id: "dev", applications: [{ id: "dev-web", name: "Web (dev)" }] }
        ]);

        expect(glance.prod?.addresses.map((address) => address.hostname)).toEqual([
            "web.example.test"
        ]);
        expect(glance.dev?.addresses.map((address) => address.hostname)).toEqual([
            "dev.example.test"
        ]);
        expect(glance.prod?.lastDeploy).toMatchObject({
            applicationId: "api",
            service: "API",
            status: "failed"
        });
        expect(glance.dev?.lastDeploy).toMatchObject({
            applicationId: "dev-web",
            status: "deploying"
        });
        expect(glance.prod?.attention).toEqual([
            { applicationId: "api", service: "API", reasons: ["last deploy failed"] }
        ]);
        expect(glance.dev?.attention).toEqual([]);
    });

    it("adds a live tunnel's hostname once, beside the service's own names", async () => {
        domainFindMany.mockResolvedValue([]);
        deploymentFindMany.mockResolvedValue([]);
        settingFindMany.mockResolvedValue([
            { key: "deploy.ngrok.web", value: "https://abc.ngrok.example" }
        ]);
        const glance = await projectGlance([
            { id: "prod", applications: [{ id: "web", name: "Web" }] }
        ]);
        expect(glance.prod?.addresses).toEqual([
            {
                id: "ngrok:web",
                hostname: "abc.ngrok.example",
                kind: "tunnel-temp",
                enabled: true,
                applicationId: "web",
                service: "Web"
            }
        ]);
        expect(glance.prod?.lastDeploy).toBeNull();
    });
});
