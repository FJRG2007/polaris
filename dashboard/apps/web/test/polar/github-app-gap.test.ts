/**
 * A repository read refused because Polaris's GitHub App is not where the
 * repository is: not installed on its owner, installed without that repository,
 * or no account linked at all. Each answer names the step and carries the button
 * the chat draws; a refusal the App does not explain keeps its old sentence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const INSTALL = "https://github.com/apps/polaris-agi/installations/new";
const ADVANCED = "https://github.com/settings/apps/polaris-agi/advanced";

const state = {
    appPublic: true as boolean | null,
    admin: true,
    credentials: [] as Array<{ connectionId: string; login: string; method: string; token: string }>
};

vi.mock("@/lib/github-access", () => ({
    credentialFor: (credentials: typeof state.credentials, owner: string) =>
        credentials.find((entry) => entry.login.toLowerCase() === owner.toLowerCase()) ??
        credentials[0] ??
        null,
    githubTokenForUser: async () => state.credentials[0]?.token ?? null,
    githubCredentialsForUser: async () => state.credentials
}));
vi.mock("@polaris/db", () => ({
    prisma: { user: { findUnique: async () => ({ isAdmin: state.admin }) } }
}));
vi.mock("@/lib/effective-access", () => ({
    effectiveIsAdmin: async (_userId: string, isAdmin: boolean) => isAdmin
}));
vi.mock("@/lib/github-service", () => ({
    githubAppInstallUrl: async () => INSTALL,
    githubAppIsPublic: async () => state.appPublic,
    githubAppVisibilityUrl: async () => ADVANCED
}));

const { polarRepoTools } = await import("@/lib/polar/code-host-tools");
const { forgetGithubAppReach, githubInstallGapForRepo, installGapKey } =
    await import("@/lib/github-app-reach");

type Reply = { status?: number; body?: unknown };
let routes: Record<string, Reply> = {};
let seen: string[] = [];

beforeEach(() => {
    forgetGithubAppReach();
    state.appPublic = true;
    state.admin = true;
    state.credentials = [
        { connectionId: "c1", login: "FJRG2007", method: "oauth", token: "user-token" }
    ];
    seen = [];
    routes = { [USER]: { body: { login: "bytehide" } } };
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
const USER = "https://api.github.com/users/bytehide";
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

describe("a private App", () => {
    it("says it has to be made public before it can be installed on another owner", async () => {
        state.appPublic = false;
        routes[INSTALLS] = { body: { installations: [installation("FJRG2007", 1, "all")] } };
        const result = await read("https://github.com/bytehide/Backend/tree/main");
        expect(result.ok).toBe(false);
        expect(result.access).toEqual({ kind: "app-private", owner: "bytehide", url: ADVANCED });
        expect(result.text).toContain("the app is private");
        expect(result.text).toContain("Make public");
    });

    it("tells somebody who is not an administrator that one has to, without the settings", async () => {
        state.appPublic = false;
        state.admin = false;
        routes[INSTALLS] = { body: { installations: [installation("FJRG2007", 1, "all")] } };
        const result = await read("https://github.com/bytehide/Backend/tree/main");
        expect(result.access).toEqual({ kind: "app-private", owner: "bytehide", url: null });
        expect(result.text).toContain("Only an administrator");
        expect(result.text).not.toContain("Make public");
        const gap = await githubInstallGapForRepo("user-1", "bytehide/Backend");
        expect(gap && installGapKey(gap)).toBe("errors.githubAppPrivateMember");
        state.admin = true;
        const own = await githubInstallGapForRepo("user-1", "bytehide/Backend");
        expect(own).toEqual({ kind: "app-private", owner: "bytehide", url: ADVANCED });
        expect(installGapKey(own!)).toBe("errors.githubAppPrivate");
    });

    it("is still an install when GitHub could not say whether the App is public", async () => {
        state.appPublic = null;
        routes[INSTALLS] = { body: { installations: [installation("FJRG2007", 1, "all")] } };
        expect(await githubInstallGapForRepo("user-1", "bytehide/Backend")).toEqual({
            kind: "app-missing",
            owner: "bytehide",
            url: INSTALL
        });
    });
});

describe("a refusal the App does not explain", () => {
    it("is a missing path, not an install, when the repository itself reads", async () => {
        routes[INSTALLS] = { body: { installations: [] } };
        routes["https://api.github.com/repos/facebook/react"] = {
            body: { full_name: "facebook/react", default_branch: "main", private: false }
        };
        const result = await read("facebook/react");
        expect(result.ok).toBe(false);
        expect(result.access).toBeUndefined();
        expect(result.text).not.toContain("not installed");
        expect(seen.some((url) => url.includes("/user/installations"))).toBe(false);
    });

    it("is not an install step for an owner GitHub does not know", async () => {
        routes[INSTALLS] = { body: { installations: [] } };
        delete routes[USER];
        expect(await githubInstallGapForRepo("user-1", "bytehide/Backend")).toBeNull();
        const result = await read("bytehide/Backend");
        expect(result.access).toBeUndefined();
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
