/**
 * The two places a service can be running that Polaris does not run.
 *
 * What is checked here is the translation, because that is where a control plane
 * lies to somebody without failing: a build that is still going drawn as live, a
 * hostname handed over without a scheme so the link lands on a path, a redeploy
 * sent for a project that has never deployed.
 *
 * Their transports are replaced. Neither Vercel's REST nor Railway's GraphQL is
 * being tested - both are somebody else's server - only what this makes of the
 * answers.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    vercelTeams: vi.fn(),
    vercelProjects: vi.fn(),
    vercelDeployments: vi.fn(),
    vercelRedeploy: vi.fn(),
    railwayProjects: vi.fn(),
    railwayProject: vi.fn(),
    railwayDeployments: vi.fn(),
    railwayDeploy: vi.fn()
}));

vi.mock("@/lib/integrations/vercel-api", () => ({
    VercelError: class extends Error {
        kind = "refused";
    },
    vercelTeams: mocks.vercelTeams,
    vercelProjects: mocks.vercelProjects,
    vercelDeployments: mocks.vercelDeployments,
    vercelRedeploy: mocks.vercelRedeploy
}));

vi.mock("@/lib/integrations/railway-api", () => ({
    RailwayError: class extends Error {
        kind = "refused";
    },
    railwayProjects: mocks.railwayProjects,
    railwayProject: mocks.railwayProject,
    railwayDeployments: mocks.railwayDeployments,
    railwayDeploy: mocks.railwayDeploy
}));

const { vercelDriver } = await import("@/lib/deploy/providers/vercel");
const { railwayDriver } = await import("@/lib/deploy/providers/railway");

beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
});

describe("a service on Vercel", () => {
    it("reads a build that is still going as building, not as live", async () => {
        mocks.vercelDeployments.mockResolvedValue([
            { uid: "dpl_1", name: "web", url: "web-abc.vercel.app", readyState: "BUILDING", state: "BUILDING", created: 1_700_000_000_000, meta: {} }
        ]);
        const state = await vercelDriver.state("token", "prj_1", {});
        expect(state.status).toBe("building");
    });

    it("gives the address a scheme, because theirs is a hostname", async () => {
        // Handed over as it arrives, a browser reads "web-abc.vercel.app" as a
        // path on Polaris.
        mocks.vercelDeployments.mockResolvedValue([
            { uid: "dpl_1", name: "web", url: "web-abc.vercel.app", readyState: "READY", state: "READY", created: 1, meta: {} }
        ]);
        const state = await vercelDriver.state("token", "prj_1", {});
        expect(state.url).toBe("https://web-abc.vercel.app");
        expect(state.status).toBe("live");
    });

    it("takes the commit from whichever git provider put it there", async () => {
        mocks.vercelDeployments.mockResolvedValue([
            {
                uid: "dpl_1",
                name: "web",
                url: null,
                readyState: "READY",
                state: "READY",
                created: 1,
                meta: { gitlabCommitSha: "abc123", gitlabCommitMessage: "Fix the header" }
            }
        ]);
        const state = await vercelDriver.state("token", "prj_1", {});
        expect(state.commitSha).toBe("abc123");
        expect(state.commitMessage).toBe("Fix the header");
    });

    it("says nothing rather than guessing about a project that has never deployed", async () => {
        mocks.vercelDeployments.mockResolvedValue([]);
        const state = await vercelDriver.state("token", "prj_1", {});
        expect(state.status).toBe("unknown");
        expect(state.url).toBeNull();
    });

    it("repeats the last release, because their redeploy names a deployment", async () => {
        mocks.vercelDeployments.mockResolvedValue([
            { uid: "dpl_9", name: "web", url: null, readyState: "READY", state: "READY", created: 1, meta: {} }
        ]);
        await vercelDriver.deploy("token", "prj_1", { team: "team_1" });
        expect(mocks.vercelRedeploy).toHaveBeenCalledWith("token", {
            name: "web",
            deployment: "dpl_9",
            team: "team_1",
            target: "production"
        });
    });

    it("refuses to deploy a project that has never deployed, rather than failing at their end", async () => {
        mocks.vercelDeployments.mockResolvedValue([]);
        await expect(vercelDriver.deploy("token", "prj_1", {})).rejects.toThrow(/never deployed/);
        expect(mocks.vercelRedeploy).not.toHaveBeenCalled();
    });

    it("carries the team through, or a personal token sees nothing", async () => {
        mocks.vercelDeployments.mockResolvedValue([]);
        await vercelDriver.state("token", "prj_1", { team: "team_7" });
        expect(mocks.vercelDeployments).toHaveBeenCalledWith(
            "token",
            expect.objectContaining({ team: "team_7", project: "prj_1" })
        );
    });
});

describe("a service on Railway", () => {
    it("offers the services under a project, since that is what deploys", async () => {
        mocks.railwayProjects.mockResolvedValue([{ id: "p1", name: "Shop" }]);
        mocks.railwayProject.mockResolvedValue({
            id: "p1",
            name: "Shop",
            services: [{ id: "s1", name: "api" }],
            environments: [
                { id: "e-dev", name: "development" },
                { id: "e-prod", name: "production" }
            ]
        });

        const choices = await railwayDriver.choices("token");
        expect(choices[0]?.children?.[0]?.id).toBe("s1");
        // Production where there is one, whatever order they came in.
        expect(choices[0]?.children?.[0]?.children?.[0]?.id).toBe("e-prod");
    });

    it("reads their words for a build that failed", async () => {
        mocks.railwayDeployments.mockResolvedValue([
            { id: "d1", status: "CRASHED", createdAt: "2026-09-01T10:00:00.000Z", staticUrl: null }
        ]);
        const state = await railwayDriver.state("token", "p1", { service: "s1", environment: "e1" });
        expect(state.status).toBe("failed");
        expect(state.at?.toISOString()).toBe("2026-09-01T10:00:00.000Z");
    });

    it("refuses a row that is missing what their API addresses a deployment by", async () => {
        // Both ids or neither: asking with half of them is a call that cannot
        // mean anything, and the sentence has to say so rather than throw an
        // undefined at somebody.
        await expect(railwayDriver.state("token", "p1", { service: "s1" })).rejects.toThrow(
            /missing what Railway needs/
        );
        expect(mocks.railwayDeployments).not.toHaveBeenCalled();
    });

    it("deploys the service instance rather than the project", async () => {
        await railwayDriver.deploy("token", "p1", { service: "s1", environment: "e1" });
        expect(mocks.railwayDeploy).toHaveBeenCalledWith("token", { service: "s1", environment: "e1" });
    });

    it("does not offer a link to a dashboard address it would have to invent", async () => {
        mocks.railwayDeployments.mockResolvedValue([
            { id: "d1", status: "SUCCESS", createdAt: "2026-09-01T10:00:00.000Z", staticUrl: "shop.up.railway.app" }
        ]);
        const state = await railwayDriver.state("token", "p1", { service: "s1", environment: "e1" });
        expect(state.inspectUrl).toBeNull();
        expect(state.url).toBe("https://shop.up.railway.app");
    });
});
