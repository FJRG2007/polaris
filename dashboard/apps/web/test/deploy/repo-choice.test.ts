/**
 * Who may point a service at a GitHub repository.
 *
 * The clone a service's build makes goes out as the project owner's account or,
 * when they have linked none, as the App an administrator installed. Either is a
 * credential that is not the person choosing the repository, so without a check
 * at the moment it is chosen anybody allowed to create a service could have
 * Polaris clone a private repository they cannot see and read the source back
 * out of the build.
 *
 * The other half is what must not change: a service already pointing at a
 * private repository keeps building as it always has. The check lives where a
 * repository is chosen, and the build path it resolves through is asserted here
 * to still lend the App to an owner who can see nothing themselves.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface Link {
    id: string;
    provider: string;
    label: string;
    method: "oauth" | "token";
}

const links = new Map<string, Link[]>();
const credentials = new Map<string, Record<string, unknown> | null>();
let installationToken: string | null = null;
/** The tokens GitHub says can read the repository being asked about. */
const reaching = new Set<string>();
let publicly = false;
const asked: string[] = [];

vi.mock("@/lib/connections/store", () => ({
    listConnections: async (userId: string, provider?: string) =>
        (links.get(userId) ?? []).filter((link) => provider === undefined || link.provider === provider),
    readCredential: async (id: string) => credentials.get(id) ?? null,
    updateCredential: async () => undefined
}));

vi.mock("@/lib/connections/health", () => ({
    noteConnectionRefused: async () => undefined
}));

vi.mock("@/lib/github-service", () => ({
    cloneAuthHeader: (token: string | null) => (token ? `Authorization: Basic ${token}` : null),
    repoAccessFor: async (_owner: string, _repo: string, token: string) => {
        asked.push(token);
        return reaching.has(token) ? "reachable" : "out-of-reach";
    },
    resolveGithubRepo: async (owner: string, repo: string, token: string | null) =>
        !token && publicly ? { fullName: `${owner}/${repo}`, defaultBranch: "main", private: false } : null,
    githubAppInstallationToken: async () => installationToken,
    listReposForPat: async () => [],
    listReposForUserToken: async () => [],
    refreshGithubUserToken: async () => {
        throw new Error("not expected");
    }
}));

const { githubCloneIdentity, githubRepoChoiceRefusal } = await import("@/lib/github-access");

const PRIVATE = "https://github.com/acme/secret-service.git";

function link(userId: string, login: string, token: string): void {
    const id = `${userId}-${login}`;
    links.set(userId, [...(links.get(userId) ?? []), { id, provider: "github", label: login, method: "oauth" }]);
    credentials.set(id, { accessToken: token });
}

const member = { id: "bruno", isAdmin: false };

beforeEach(() => {
    links.clear();
    credentials.clear();
    reaching.clear();
    asked.length = 0;
    installationToken = "instance-token";
    publicly = false;
});

describe("choosing a private repository the App installation covers", () => {
    it("refuses a member who cannot see it, and says where to fix that", async () => {
        const said = await githubRepoChoiceRefusal(member, "bruno", PRIVATE);
        expect(said).toContain("acme/secret-service");
        expect(said).toContain("Connected accounts");
        expect(said).not.toMatch(/\.env|terminal|command/i);
    });

    it("refuses a member whose linked account GitHub says cannot reach it", async () => {
        link("bruno", "bruno-gh", "gho_bruno");
        const said = await githubRepoChoiceRefusal(member, "ana", PRIVATE);
        expect(said).toContain("None of your connected GitHub accounts");
        expect(asked).toEqual(["gho_bruno"]);
    });

    it("refuses a collaborator on a project whose owner's own account would clone it", async () => {
        installationToken = null;
        link("ana", "ana-gh", "gho_ana");
        expect(await githubRepoChoiceRefusal(member, "ana", PRIVATE)).not.toBeNull();
    });

    it("allows a member whose own linked account can read it", async () => {
        link("bruno", "bruno-gh", "gho_bruno");
        reaching.add("gho_bruno");
        expect(await githubRepoChoiceRefusal(member, "ana", PRIVATE)).toBeNull();
    });

    it("allows the owner of the account the App is installed on", async () => {
        link("bruno", "acme", "gho_acme");
        expect(await githubRepoChoiceRefusal(member, "ana", PRIVATE)).toBeNull();
    });

    it("allows an administrator whatever they have linked", async () => {
        expect(await githubRepoChoiceRefusal({ id: "root", isAdmin: true }, "bruno", PRIVATE)).toBeNull();
        expect(asked).toEqual([]);
    });

    it("allows the project owner cloning as their own account", async () => {
        link("bruno", "bruno-gh", "gho_bruno");
        expect(await githubRepoChoiceRefusal(member, "bruno", PRIVATE)).toBeNull();
    });
});

describe("repositories nothing is lent for", () => {
    it("allows a public repository", async () => {
        publicly = true;
        expect(await githubRepoChoiceRefusal(member, "bruno", PRIVATE)).toBeNull();
    });

    it("allows anything when the clone would go out as nobody", async () => {
        installationToken = null;
        expect(await githubRepoChoiceRefusal(member, "bruno", PRIVATE)).toBeNull();
    });

    it("says nothing about a repository that is not on GitHub", async () => {
        expect(await githubRepoChoiceRefusal(member, "bruno", "https://gitlab.com/acme/secret-service.git")).toBeNull();
        expect(await githubRepoChoiceRefusal(member, "bruno", "https://elsewhere.example/github.com/acme/r")).toBeNull();
    });
});

describe("a service that already points at a private repository", () => {
    it("still builds as the App for an owner who can see nothing themselves", async () => {
        // The member refused above, as the owner of a row made before the check:
        // the build resolves its clone the way it always has.
        expect(await githubRepoChoiceRefusal(member, "bruno", PRIVATE)).not.toBeNull();
        const identity = await githubCloneIdentity("bruno", "acme");
        expect(identity?.header).toBe("Authorization: Basic instance-token");
        expect(identity?.as).toContain("GitHub App");
    });
});
