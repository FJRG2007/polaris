/**
 * "N commits behind" compares the live release's commit with the head of the
 * branch the service tracks - not the poller's bookmark - and asks GitHub once a
 * minute at most for the same question.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const applicationFind = vi.fn();
const deploymentFind = vi.fn();

vi.mock("@polaris/db", () => ({
    prisma: {
        application: { findUnique: applicationFind },
        deployment: { findUnique: deploymentFind }
    }
}));
vi.mock("../../src/lib/github-access", () => ({ githubTokenForOwner: async () => "token" }));

const { deployFreshness } = await import("../../src/lib/deploy/freshness");

const LIVE = "1111111111111111111111111111111111111111";
let appCounter = 0;

function gitApp(overrides: Record<string, unknown> = {}) {
    return {
        sourceType: "dockerfile",
        sourceConfig: JSON.stringify({ repoUrl: "https://github.com/acme/web" }),
        deployBranch: null,
        currentDeploymentId: "dep-1",
        environment: { branch: null, project: { ownerId: `owner-${++appCounter}` } },
        ...overrides
    };
}

const fetchMock = vi.fn();

describe("deployFreshness", () => {
    beforeEach(() => {
        applicationFind.mockReset();
        deploymentFind.mockReset();
        fetchMock.mockReset();
        vi.stubGlobal("fetch", fetchMock);
        deploymentFind.mockResolvedValue({ commitSha: LIVE });
        fetchMock.mockResolvedValue(
            new Response(
                JSON.stringify({
                    ahead_by: 3,
                    html_url: "https://github.com/acme/web/compare/x...main"
                }),
                {
                    status: 200
                }
            )
        );
    });
    afterEach(() => vi.unstubAllGlobals());

    it("counts the commits on the tracked branch the live release does not have", async () => {
        applicationFind.mockResolvedValue(
            gitApp({ environment: { branch: "main", project: { ownerId: "o-a" } } })
        );
        const result = await deployFreshness("app-1");
        expect(result).toEqual({
            branch: "main",
            behindBy: 3,
            compareUrl: "https://github.com/acme/web/compare/x...main"
        });
        const url = String(fetchMock.mock.calls[0]?.[0]);
        expect(url).toContain(`/repos/acme/web/compare/${LIVE}...main`);
    });

    it("asks GitHub once for the same release and branch within a minute", async () => {
        applicationFind.mockResolvedValue(
            gitApp({ environment: { branch: "main", project: { ownerId: "o-b" } } })
        );
        await deployFreshness("app-2");
        await deployFreshness("app-2");
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it("says nothing for a service built from an image", async () => {
        applicationFind.mockResolvedValue(gitApp({ sourceType: "image" }));
        expect(await deployFreshness("app-3")).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("says nothing for a service never deployed, or a release with no commit", async () => {
        applicationFind.mockResolvedValue(gitApp({ currentDeploymentId: null }));
        expect(await deployFreshness("app-4")).toBeNull();
        applicationFind.mockResolvedValue(gitApp({ deployBranch: "main" }));
        deploymentFind.mockResolvedValue({ commitSha: null });
        expect(await deployFreshness("app-5")).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("says nothing when GitHub will not compare", async () => {
        applicationFind.mockResolvedValue(gitApp({ deployBranch: "main" }));
        fetchMock.mockResolvedValue(new Response("{}", { status: 404 }));
        expect(await deployFreshness("app-6")).toBeNull();
    });
});
