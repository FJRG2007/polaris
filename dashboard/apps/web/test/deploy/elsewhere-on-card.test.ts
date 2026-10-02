/**
 * A service that also runs on Vercel or Railway shows that provider's production
 * domains on its card.
 *
 * Which row belongs to which service is decided without guessing from a name:
 * somebody linked them (or a move did), or both build the same repository. And the
 * domains are the provider's own production ones - never the per-deployment URL,
 * and never a name that only redirects to another.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findMany = vi.fn();
vi.mock("@polaris/db", () => ({ prisma: { externalService: { findMany } } }));
vi.mock("@/lib/connections/store", () => ({ readCredential: async () => null }));

const { elsewhereByService, repoOfSource } = await import("@/lib/deploy/external-services");
const { vercelProductionDomains } = await import("@/lib/integrations/vercel-api");
const { railwayDomains } = await import("@/lib/integrations/railway-api");

const row = {
    id: "ext-1",
    provider: "vercel",
    name: "portfolio-v3",
    status: "live",
    url: "https://portfolio-v3-abc123.vercel.app",
    applicationId: null as string | null,
    repo: "fjrg2007/portfolio-v3" as string | null,
    productionDomains: JSON.stringify(["fjrg2007.com"])
};

beforeEach(() => findMany.mockReset());
afterEach(() => vi.unstubAllGlobals());

describe("which service a provider's copy belongs to", () => {
    const portfolio = {
        id: "app-1",
        sourceConfig: JSON.stringify({ repoUrl: "https://github.com/FJRG2007/portfolio-v3" })
    };
    const other = {
        id: "app-2",
        sourceConfig: JSON.stringify({ repoUrl: "https://github.com/FJRG2007/other" })
    };

    it("matches the service building the same repository", async () => {
        findMany.mockResolvedValue([row]);
        const byService = await elsewhereByService("project-1", [portfolio, other]);
        expect(byService.get("app-1")).toEqual([
            {
                id: "ext-1",
                provider: "vercel",
                name: "portfolio-v3",
                status: "live",
                domains: ["fjrg2007.com"],
                url: "https://portfolio-v3-abc123.vercel.app",
                linked: "repository"
            }
        ]);
        expect(byService.has("app-2")).toBe(false);
        expect(findMany).toHaveBeenCalledTimes(1);
    });

    it("lets an explicit link win over the repository", async () => {
        findMany.mockResolvedValue([{ ...row, applicationId: "app-2" }]);
        const byService = await elsewhereByService("project-1", [portfolio, other]);
        expect(byService.has("app-1")).toBe(false);
        expect(byService.get("app-2")?.[0]?.linked).toBe("explicit");
    });

    it("matches nothing on a name alone", async () => {
        findMany.mockResolvedValue([{ ...row, repo: null }]);
        expect((await elsewhereByService("project-1", [portfolio])).size).toBe(0);
    });

    it("reads a repository however it was written", () => {
        expect(
            repoOfSource(JSON.stringify({ repoUrl: "git@github.com:FJRG2007/Portfolio-V3.git" }))
        ).toBe("fjrg2007/portfolio-v3");
        expect(repoOfSource(JSON.stringify({ imageRef: "nginx" }))).toBeNull();
    });
});

describe("the provider's production domains", () => {
    it("asks Vercel for production domains that do not redirect, in the project's team", async () => {
        const fetchMock = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        domains: [
                            {
                                name: "fjrg2007.com",
                                apexName: "fjrg2007.com",
                                projectId: "prj",
                                verified: true
                            },
                            {
                                name: "www.fjrg2007.com",
                                apexName: "fjrg2007.com",
                                projectId: "prj",
                                verified: true,
                                redirect: "fjrg2007.com"
                            },
                            {
                                name: "pending.example.com",
                                apexName: "example.com",
                                projectId: "prj",
                                verified: false
                            }
                        ],
                        pagination: { count: 3, next: null, prev: null }
                    }),
                    { status: 200 }
                )
        );
        vi.stubGlobal("fetch", fetchMock);
        expect(await vercelProductionDomains("token", "prj_1", "team_9")).toEqual(["fjrg2007.com"]);
        const url = String(fetchMock.mock.calls[0]?.[0]);
        expect(url).toContain("/v9/projects/prj_1/domains?");
        expect(url).toContain("production=true");
        expect(url).toContain("redirects=false");
        expect(url).toContain("teamId=team_9");
    });

    it("asks Railway for one service's custom domains first, then its generated ones", async () => {
        const fetchMock = vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        data: {
                            domains: {
                                serviceDomains: [{ domain: "web-production.up.railway.app" }],
                                customDomains: [{ domain: "Shop.Example.com" }]
                            }
                        }
                    }),
                    { status: 200 }
                )
        );
        vi.stubGlobal("fetch", fetchMock);
        expect(
            await railwayDomains("token", { project: "p", service: "s", environment: "e" })
        ).toEqual(["shop.example.com", "web-production.up.railway.app"]);
        const body = JSON.parse(String((fetchMock.mock.calls[0]?.[1] as RequestInit).body));
        expect(body.variables).toEqual({ projectId: "p", environmentId: "e", serviceId: "s" });
    });
});
