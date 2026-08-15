/**
 * What Polaris actually asks GitHub, and what it says when GitHub says no.
 *
 * The query is the part worth pinning down: "waiting on my review" and "assigned
 * to me" are different qualifiers, and getting one wrong produces a list that is
 * plausible, wrong, and completely silent about it.
 *
 * The refusals matter for the opposite reason. A rate limit, an expired link and
 * a repository the token cannot see are three different next steps for the
 * reader, and collapsing them into "that failed" is how somebody spends an
 * afternoon reconnecting an account that was working.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let token: string | null = "gho_token";
const fetchMock = vi.fn();

vi.mock("@/lib/github-access", () => ({
    githubTokenForUser: async () => token
}));

const code = await import("../../src/lib/code/code-service");

function answer(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
    return {
        ok: (init.status ?? 200) < 400,
        status: init.status ?? 200,
        headers: { get: (key: string) => init.headers?.[key.toLowerCase()] ?? null },
        json: async () => body
    };
}

/** The URL of the most recent call, decoded, so an assertion reads like the
 *  query somebody would type into GitHub. */
function lastQuery(): string {
    const url = String(fetchMock.mock.calls.at(-1)?.[0] ?? "");
    return decodeURIComponent(url);
}

beforeEach(() => {
    token = "gho_token";
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
});

describe("what is asked for", () => {
    it("asks for pull requests waiting on this person's review", async () => {
        fetchMock.mockResolvedValue(answer({ items: [] }));

        await code.listWork("u1", { kind: "pr", scope: "review", state: "open" });

        expect(lastQuery()).toContain("is:pr is:open review-requested:@me");
    });

    it("uses a different qualifier for each way of being involved", async () => {
        fetchMock.mockResolvedValue(answer({ items: [] }));

        await code.listWork("u1", { kind: "issue", scope: "assigned", state: "open" });
        expect(lastQuery()).toContain("assignee:@me");

        await code.listWork("u1", { kind: "issue", scope: "created", state: "open" });
        expect(lastQuery()).toContain("author:@me");

        await code.listWork("u1", { kind: "issue", scope: "mentioned", state: "open" });
        expect(lastQuery()).toContain("mentions:@me");

        await code.listWork("u1", { kind: "issue", scope: "all", state: "open" });
        expect(lastQuery()).toContain("involves:@me");
    });

    it("leaves the state out when the reader asked for all of them", async () => {
        fetchMock.mockResolvedValue(answer({ items: [] }));

        await code.listWork("u1", { kind: "pr", scope: "all", state: "all" });

        expect(lastQuery()).not.toContain("is:open");
        expect(lastQuery()).not.toContain("is:closed");
    });

    it("passes extra qualifiers through, so somebody who knows the syntax can use it", async () => {
        fetchMock.mockResolvedValue(answer({ items: [] }));

        await code.listWork("u1", {
            kind: "pr",
            scope: "all",
            state: "open",
            query: "repo:acme/edge label:bug"
        });

        expect(lastQuery()).toContain("repo:acme/edge label:bug");
    });

    it("says to link an account rather than asking GitHub as nobody", async () => {
        token = null;

        await expect(
            code.listWork("u1", { kind: "pr", scope: "all", state: "open" })
        ).rejects.toThrow(/Link a GitHub account/);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe("reading a row back", () => {
    it("takes the repository out of the API url the search returns", async () => {
        fetchMock.mockResolvedValue(
            answer({
                items: [
                    {
                        id: 1,
                        number: 42,
                        title: "Fix the edge",
                        state: "open",
                        created_at: "2026-08-01T00:00:00Z",
                        updated_at: "2026-08-02T00:00:00Z",
                        html_url: "https://github.com/acme/edge/pull/42",
                        repository_url: "https://api.github.com/repos/acme/edge",
                        user: { login: "ada" },
                        pull_request: {}
                    }
                ]
            })
        );

        const [item] = await code.listWork("u1", { kind: "pr", scope: "all", state: "open" });

        expect(item!.repo).toBe("acme/edge");
        expect(item!.kind).toBe("pr");
        expect(item!.state).toBe("open");
    });

    it("calls a merged pull request merged rather than closed", async () => {
        fetchMock.mockResolvedValue(
            answer({
                items: [
                    {
                        id: 2,
                        number: 7,
                        title: "Ship it",
                        state: "closed",
                        created_at: "2026-08-01T00:00:00Z",
                        updated_at: "2026-08-02T00:00:00Z",
                        html_url: "https://github.com/acme/edge/pull/7",
                        repository_url: "https://api.github.com/repos/acme/edge",
                        pull_request: { merged_at: "2026-08-02T00:00:00Z" }
                    }
                ]
            })
        );

        const [item] = await code.listWork("u1", { kind: "pr", scope: "all", state: "all" });

        expect(item!.state).toBe("merged");
    });
});

describe("when GitHub refuses", () => {
    it("tells a rate limit apart from a permission", async () => {
        fetchMock.mockResolvedValue(
            answer({}, { status: 403, headers: { "x-ratelimit-remaining": "0" } })
        );
        await expect(
            code.listWork("u1", { kind: "pr", scope: "all", state: "open" })
        ).rejects.toThrow(/rate limiting/);

        fetchMock.mockResolvedValue(
            answer({}, { status: 403, headers: { "x-ratelimit-remaining": "42" } })
        );
        await expect(
            code.listWork("u1", { kind: "pr", scope: "all", state: "open" })
        ).rejects.toThrow(/cannot do that/);
    });

    it("says to reconnect when the link itself has stopped working", async () => {
        fetchMock.mockResolvedValue(answer({}, { status: 401 }));

        await expect(
            code.listWork("u1", { kind: "pr", scope: "all", state: "open" })
        ).rejects.toThrow(/Reconnect/);
    });

    it("does not distinguish gone from never-visible", async () => {
        fetchMock.mockResolvedValue(answer({}, { status: 404 }));

        await expect(code.readWork("u1", "acme", "edge", 1)).rejects.toThrow(
            /not there, or not visible/
        );
    });

    it("explains a refused merge as the state it is in", async () => {
        fetchMock.mockResolvedValue(answer({}, { status: 405 }));

        await expect(code.merge("u1", "acme", "edge", 1, "squash")).rejects.toThrow(
            /not in a mergeable state/
        );
    });
});
