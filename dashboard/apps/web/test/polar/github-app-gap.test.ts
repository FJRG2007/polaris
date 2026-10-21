/**
 * A repository read refused because Polaris's GitHub App is not where the
 * repository is: not installed on its owner, installed without that repository,
 * or no account linked at all. Each answer names the step and carries the button
 * the chat draws; a refusal the App does not explain keeps its old sentence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INSTALL = "https://github.com/apps/polaris-agi/installations/new";

const state = {
    credentials: [] as Array<{ connectionId: string; login: string; method: string; token: string }>
};

vi.mock("@/lib/github-access", () => ({
    githubTokenForUser: async () => state.credentials[0]?.token ?? null,
    githubCredentialsForUser: async () => state.credentials
}));
vi.mock("@/lib/github-service", () => ({
    githubAppInstallUrl: async () => INSTALL
}));

const { polarRepoTools } = await import("@/lib/polar/code-host-tools");
const { forgetGithubAppReach, githubInstallGapForRepo } = await import("@/lib/github-app-reach");

type Reply = { status?: number; body?: unknown };
let routes: Record<string, Reply> = {};
let seen: string[] = [];

beforeEach(() => {
    forgetGithubAppReach();
    state.credentials = [
        { connectionId: "c1", login: "FJRG2007", method: "oauth", token: "user-token" }
    ];
    seen = [];
    routes = {};
    vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string) => {
            const url = String(input);
            seen.push(url);
            const reply = routes[url] ?? { status: 404, body: { message: "Not Found" } };
            return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 });
        })
    );
});

afterEach(() => {
    vi.unstubAllGlobals();
});

const INSTALLS = "https://api.github.com/user/installations?per_page=100&page=1";
const OPTIONS = { toolCallId: "call-1", messages: [] };

function installation(login: string, id: number, selection: "all" | "selected") {
    return {
        id,
        account: { login, id: id * 10, type: "Organization" },
        repository_selection: selection,
        html_url: `https://github.com/organizations/${login}/settings/installations/${id}`
    };
}

async function read(repository: string) {
    const tools = polarRepoTools("user-1");
    return (await tools.repo_read_file!.execute!(
        { repository, path: "composer.json" } as never,
        OPTIONS as never
    )) as { ok: boolean; text: string; access?: Record<string, unknown> };
}

describe("a repository whose owner lacks the App", () => {
    it("says Polaris must be installed there and carries the install button", async () => {
        routes[INSTALLS] = { body: { installations: [installation("FJRG2007", 1, "all")] } };
        const result = await read("https://github.com/bytehide/Backend/tree/main");
        expect(result.ok).toBe(false);
        expect(result.access).toEqual({ kind: "app-missing", owner: "bytehide", url: INSTALL });
        expect(result.text).toContain("not installed on bytehide");
        expect(result.text).toContain("owner to approve");
        expect(result.text).toContain('"Install Polaris on bytehide"');
        // The token is never in what the model reads.
        expect(JSON.stringify(result)).not.toContain("user-token");
    });

    it("is reported for the agents screens too, without a repository list", async () => {
        routes[INSTALLS] = { body: { installations: [] } };
        expect(await githubInstallGapForRepo("user-1", "bytehide/Backend")).toEqual({
            kind: "app-missing",
            owner: "bytehide",
            url: INSTALL
        });
    });
});

describe("an installation on selected repositories", () => {
    it("says the repository was not given to it, with the installation's page", async () => {
        routes[INSTALLS] = { body: { installations: [installation("bytehide", 7, "selected")] } };
        routes["https://api.github.com/user/installations/7/repositories?per_page=100&page=1"] = {
            body: { repositories: [{ full_name: "bytehide/Frontend" }] }
        };
        const result = await read("bytehide/Backend");
        expect(result.access).toEqual({
            kind: "repo-not-selected",
            owner: "bytehide",
            repository: "bytehide/Backend",
            url: "https://github.com/organizations/bytehide/settings/installations/7"
        });
        expect(result.text).toContain("only on selected repositories");
    });

    it("leaves the old sentence when the repository is one of them", async () => {
        routes[INSTALLS] = { body: { installations: [installation("bytehide", 7, "selected")] } };
        routes["https://api.github.com/user/installations/7/repositories?per_page=100&page=1"] = {
            body: { repositories: [{ full_name: "bytehide/backend" }] }
        };
        const result = await read("bytehide/Backend");
        expect(result.access).toBeUndefined();
        expect(result.text).toContain("linked GitHub account cannot see it");
    });

    it("never links anywhere but github.com", async () => {
        routes[INSTALLS] = {
            body: {
                installations: [
                    { ...installation("bytehide", 7, "selected"), html_url: "https://evil.test/x" }
                ]
            }
        };
        routes["https://api.github.com/user/installations/7/repositories?per_page=100&page=1"] = {
            body: { repositories: [] }
        };
        const result = await read("bytehide/Backend");
        expect(result.access?.url).toBeNull();
    });
});

describe("no linked account", () => {
    it("keeps the connect sentence and links Connected accounts", async () => {
        state.credentials = [];
        const result = await read("bytehide/Backend");
        expect(result.access).toEqual({
            kind: "no-account",
            owner: "bytehide",
            url: "/account/connections"
        });
        expect(result.text).toContain("Connected accounts (/account/connections)");
        // Nothing asked of GitHub's installation API without an account.
        expect(seen.some((url) => url.includes("/user/installations"))).toBe(false);
    });

    it("is not a gap for the agents screens, which have their own fallback", async () => {
        state.credentials = [];
        expect(await githubInstallGapForRepo("user-1", "bytehide/Backend")).toBeNull();
    });
});

describe("when the App is not the reason", () => {
    it("says nothing extra for a personal access token", async () => {
        state.credentials = [{ connectionId: "c2", login: "x", method: "token", token: "pat" }];
        const result = await read("bytehide/Backend");
        expect(result.access).toBeUndefined();
        expect(seen.some((url) => url.includes("/user/installations"))).toBe(false);
    });

    it("says nothing extra when GitHub will not list installations", async () => {
        routes[INSTALLS] = { status: 500 };
        const result = await read("bytehide/Backend");
        expect(result.access).toBeUndefined();
        expect(result.text).toContain("not found");
    });

    it("asks GitHub once for an owner the App is installed on, then remembers", async () => {
        routes[INSTALLS] = { body: { installations: [installation("bytehide", 7, "all")] } };
        await read("bytehide/Backend");
        await read("bytehide/Backend");
        expect(seen.filter((url) => url === INSTALLS)).toHaveLength(1);
    });
});
