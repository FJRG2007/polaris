/**
 * A GitHub repository list follows every page of its `Link` header, up to a
 * bound, so an account with more than a hundred repositories sees them all.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/integration-service", () => ({
    getIntegration: async () => null,
    getIntegrationSecret: async () => null
}));

const { listReposForPat, listReposForUserToken, nextPageUrl } = await import("@/lib/github-service");

const API = "https://api.github.com";
const row = (name: string) => ({ full_name: name, default_branch: "main", private: false });
const next = (url: string) => ({ link: `<${url}>; rel="next", <${API}/last>; rel="last"` });

function answer(pages: Record<string, { status?: number; body: unknown; headers?: Record<string, string> }>) {
    const asked: string[] = [];
    vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
            asked.push(url);
            const page = pages[url] ?? { status: 404, body: {} };
            return new Response(JSON.stringify(page.body), {
                status: page.status ?? 200,
                headers: page.headers ?? {}
            });
        })
    );
    return asked;
}

afterEach(() => vi.unstubAllGlobals());

describe("nextPageUrl", () => {
    it("reads the next page, and nothing on the last one or off GitHub's API", () => {
        expect(nextPageUrl(`<${API}/user/repos?page=2>; rel="next", <${API}/user/repos?page=5>; rel="last"`)).toBe(
            `${API}/user/repos?page=2`
        );
        expect(nextPageUrl(`<${API}/user/repos?page=1>; rel="prev"`)).toBeNull();
        expect(nextPageUrl(`<https://evil.test/x>; rel="next"`)).toBeNull();
        expect(nextPageUrl(null)).toBeNull();
    });
});

describe("listReposForPat", () => {
    const first = `${API}/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member`;

    it("follows every page", async () => {
        answer({
            [first]: { body: [row("acme/a")], headers: next(`${API}/p2`) },
            [`${API}/p2`]: { body: [row("acme/b"), row("acme/a")] }
        });
        expect((await listReposForPat("t")).map((repo) => repo.fullName)).toEqual(["acme/a", "acme/b"]);
    });

    it("throws when the first page fails, keeps what it has when a later one does", async () => {
        answer({ [first]: { status: 401, body: {} } });
        await expect(listReposForPat("t")).rejects.toThrow("unauthorized");
        answer({ [first]: { body: [row("acme/a")], headers: next(`${API}/p2`) } });
        expect(await listReposForPat("t")).toHaveLength(1);
    });

    it("stops at its page bound", async () => {
        const asked = answer({});
        vi.stubGlobal(
            "fetch",
            vi.fn(async (url: string) => {
                asked.push(url);
                return new Response(JSON.stringify([row(`acme/${asked.length}`)]), {
                    headers: next(`${API}/p${asked.length + 1}`)
                });
            })
        );
        expect(await listReposForPat("t")).toHaveLength(10);
        expect(asked).toHaveLength(10);
    });
});

describe("listReposForUserToken", () => {
    it("pages installations and their repositories, skipping one GitHub will not list", async () => {
        answer({
            [`${API}/user/installations?per_page=100`]: {
                body: { installations: [{ id: 1 }] },
                headers: next(`${API}/i2`)
            },
            [`${API}/i2`]: { body: { installations: [{ id: 2 }] } },
            [`${API}/user/installations/1/repositories?per_page=100`]: {
                body: { repositories: [row("acme/a")] },
                headers: next(`${API}/r2`)
            },
            [`${API}/r2`]: { body: { repositories: [row("acme/b")] } },
            [`${API}/user/installations/2/repositories?per_page=100`]: { status: 500, body: {} }
        });
        expect((await listReposForUserToken("t")).map((repo) => repo.fullName)).toEqual(["acme/a", "acme/b"]);
    });
});
