/**
 * Whose credentials a GitHub call is made with.
 *
 * This is the regression the whole change exists for: Deploy used to list, resolve
 * and inspect repositories with one instance-wide token, so a second account on
 * the box saw the operator's private repositories. Anything a person asks for
 * must therefore resolve to their own accounts and stop there - a fallback to the
 * shared credential would restore the leak without failing anything visibly.
 *
 * The other half is the opposite risk. Work with nobody watching (the auto-deploy
 * poll, a build cloning) has no session, so it resolves the project owner and then
 * the App installation. Getting that wrong stops every service deploying, which is
 * why the fallback is asserted as carefully as its absence.
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
const updated: Array<{ id: string; credential: Record<string, unknown> }> = [];
let installationToken: string | null = null;
let refreshCalls = 0;
let patLists: string[] = [];
let userTokenLists: string[] = [];

vi.mock("@/lib/connections/store", () => ({
    listConnections: async (userId: string, provider?: string) =>
        (links.get(userId) ?? []).filter((link) => provider === undefined || link.provider === provider),
    readCredential: async (id: string) => credentials.get(id) ?? null,
    updateCredential: async (id: string, credential: Record<string, unknown>) => {
        credentials.set(id, credential);
        updated.push({ id, credential });
    }
}));

/** What GitHub is standing in for: how it answers about one repository, asked
 *  with a token and asked with none. */
let access: "reachable" | "token-refused" | "out-of-reach" | "sso-required" | "unknown" = "reachable";
let publicly = false;
const refused: string[] = [];

vi.mock("@/lib/connections/health", () => ({
    noteConnectionRefused: async (userId: string) => {
        refused.push(userId);
    }
}));

vi.mock("@/lib/github-service", () => ({
    cloneAuthHeader: (token: string | null) => (token ? `Authorization: Basic ${token}` : null),
    repoAccessFor: async () => access,
    resolveGithubRepo: async (owner: string, repo: string, token: string | null) =>
        !token && publicly ? { fullName: `${owner}/${repo}`, defaultBranch: "main", private: false } : null,
    githubAppInstallationToken: async () => installationToken,
    listReposForPat: async (token: string) => {
        patLists.push(token);
        return [{ fullName: "ana/personal", defaultBranch: "main", private: true }];
    },
    listReposForUserToken: async (token: string) => {
        userTokenLists.push(token);
        return [{ fullName: "acme/service", defaultBranch: "main", private: true }];
    },
    refreshGithubUserToken: async (refreshToken: string) => {
        refreshCalls += 1;
        return { accessToken: `fresh-for-${refreshToken}`, refreshToken: "ghr_next", expiresAt: Date.now() + 3_600_000, scope: "" };
    }
}));

const {
    githubCloneIdentity,
    githubCredentialsForUser,
    githubRepoReach,
    githubTokenForOwner,
    githubTokenForUser,
    listReposForUser
} = await import("@/lib/github-access");

function link(userId: string, entry: Link, credential: Record<string, unknown> | null): void {
    links.set(userId, [...(links.get(userId) ?? []), entry]);
    credentials.set(entry.id, credential);
}

beforeEach(() => {
    links.clear();
    credentials.clear();
    updated.length = 0;
    installationToken = null;
    refreshCalls = 0;
    patLists = [];
    userTokenLists = [];
});

describe("what somebody asking for themselves gets", () => {
    it("is nothing at all when they have linked no account", async () => {
        installationToken = "instance-token";
        expect(await githubTokenForUser("bruno")).toBeNull();
        expect(await listReposForUser("bruno")).toEqual([]);
    });

    it("never falls back to the instance credential", async () => {
        installationToken = "instance-token";
        link("ana", { id: "c1", provider: "github", label: "ana", method: "oauth" }, { accessToken: "gho_ana" });

        expect(await githubTokenForUser("bruno")).toBeNull();
        expect(await githubTokenForUser("ana")).toBe("gho_ana");
    });

    it("prefers the account that owns the repository being asked about", async () => {
        link("ana", { id: "c1", provider: "github", label: "ana", method: "oauth" }, { accessToken: "gho_personal" });
        link("ana", { id: "c2", provider: "github", label: "acme-ana", method: "oauth" }, { accessToken: "gho_work" });

        expect(await githubTokenForUser("ana", "acme-ana")).toBe("gho_work");
        // An owner none of their accounts is named for falls to the first, which is
        // still one of theirs.
        expect(await githubTokenForUser("ana", "someone-else")).toBe("gho_personal");
    });

    it("lists through the right call for how each account was connected", async () => {
        link("ana", { id: "c1", provider: "github", label: "ana", method: "token" }, { token: "ghp_pasted" });
        link("ana", { id: "c2", provider: "github", label: "acme-ana", method: "oauth" }, { accessToken: "gho_work" });

        const repos = await listReposForUser("ana");
        expect(patLists).toEqual(["ghp_pasted"]);
        expect(userTokenLists).toEqual(["gho_work"]);
        expect(repos.map((repo) => repo.fullName)).toEqual(["ana/personal", "acme/service"]);
    });

    it("leaves out an account whose credential can no longer be read", async () => {
        link("ana", { id: "c1", provider: "github", label: "ana", method: "oauth" }, null);
        expect(await githubCredentialsForUser("ana")).toEqual([]);
    });
});

describe("a user token that has aged out", () => {
    it("is refreshed and the new one kept, so the next call does not refresh again", async () => {
        link(
            "ana",
            { id: "c1", provider: "github", label: "ana", method: "oauth" },
            { accessToken: "gho_stale", refreshToken: "ghr_ana", expiresAt: Date.now() - 1_000 }
        );

        expect(await githubTokenForUser("ana")).toBe("fresh-for-ghr_ana");
        expect(refreshCalls).toBe(1);
        expect(updated[0]?.credential).toMatchObject({ accessToken: "fresh-for-ghr_ana", refreshToken: "ghr_next" });

        expect(await githubTokenForUser("ana")).toBe("fresh-for-ghr_ana");
        expect(refreshCalls).toBe(1);
    });

    it("is left alone when the app issues tokens that do not expire", async () => {
        link("ana", { id: "c1", provider: "github", label: "ana", method: "oauth" }, { accessToken: "gho_forever" });
        expect(await githubTokenForUser("ana")).toBe("gho_forever");
        expect(refreshCalls).toBe(0);
    });
});

describe("work with nobody watching", () => {
    it("acts as the owner of the project when they have an account", async () => {
        installationToken = "instance-token";
        link("ana", { id: "c1", provider: "github", label: "ana", method: "oauth" }, { accessToken: "gho_ana" });
        expect(await githubTokenForOwner("ana")).toBe("gho_ana");
    });

    it("falls back to the App installation, which is what keeps existing services building", async () => {
        installationToken = "instance-token";
        expect(await githubTokenForOwner("ana")).toBe("instance-token");
        expect(await githubCloneIdentity("ana", "acme")).toEqual({
            header: "Authorization: Basic instance-token",
            as: "the GitHub App installed on this Polaris"
        });
    });

    it("clones anonymously rather than with somebody else's credential", async () => {
        installationToken = null;
        link("bruno", { id: "c9", provider: "github", label: "bruno", method: "oauth" }, { accessToken: "gho_bruno" });
        expect(await githubCloneIdentity("ana", "acme")).toBeNull();
    });

    // The name is what the deployment log says before it tries, so a build that
    // went out as nobody says so in advance rather than only in git's words
    // afterwards.
    it("names the account the clone goes out as", async () => {
        installationToken = null;
        link("ana", { id: "c1", provider: "github", label: "ana", method: "oauth" }, { accessToken: "gho_ana" });
        expect(await githubCloneIdentity("ana", "acme")).toEqual({
            header: "Authorization: Basic gho_ana",
            as: "ana"
        });
    });
});

/**
 * Whether a deploy is allowed to start at all.
 *
 * The failure this replaces: a token that had quietly run out, a deploy queued
 * anyway, eight minutes of build slot, and a log ending in git asking a terminal
 * that does not exist for a username. Every answer below is a sentence about
 * something to go and do, and the two that must NOT refuse are as important as
 * the ones that must - a public repository has never needed an account, and
 * refusing one because nothing is linked would stop deploys that have always
 * worked.
 */
describe("whether a deploy can reach its own source", () => {
    const REPO = "https://github.com/acme/widgets.git";

    beforeEach(() => {
        access = "reachable";
        publicly = false;
        refused.length = 0;
        installationToken = null;
    });

    it("says nothing about a repository somewhere other than GitHub", async () => {
        expect(await githubRepoReach("ana", "https://gitlab.com/acme/widgets.git")).toBeNull();
    });

    it("lets a public repository through with nothing connected, as it always could", async () => {
        publicly = true;
        expect(await githubRepoReach("ana", REPO)).toBeNull();
    });

    it("refuses a private one with nothing connected, and says what to connect", async () => {
        const said = await githubRepoReach("ana", REPO);
        expect(said).toContain("acme/widgets");
        expect(said).toContain("Connected accounts");
    });

    it("lets a reachable repository through", async () => {
        link("ana", { id: "c1", provider: "github", label: "ana", method: "token" }, { token: "ghp_ana" });
        expect(await githubRepoReach("ana", REPO)).toBeNull();
    });

    it("refuses when the account can no longer speak for anybody, and notes that the link broke", async () => {
        link("ana", { id: "c1", provider: "github", label: "ana", method: "token" }, { token: "ghp_ana" });
        access = "token-refused";
        const said = await githubRepoReach("ana", REPO);
        expect(said).toContain("stopped working");
        expect(refused).toEqual(["ana"]);
    });

    // The token expiring is still worth recording and still worth telling its
    // owner about - it just has nothing to do with cloning a public repository,
    // and must not stop one.
    it("still lets a public repository through when the token expired", async () => {
        link("ana", { id: "c1", provider: "github", label: "ana", method: "token" }, { token: "ghp_ana" });
        access = "token-refused";
        publicly = true;
        expect(await githubRepoReach("ana", REPO)).toBeNull();
        expect(refused).toEqual(["ana"]);
    });

    it("names the app installation when the account is fine and the repository is not its to see", async () => {
        link("ana", { id: "c1", provider: "github", label: "ana", method: "oauth" }, { accessToken: "gho_ana" });
        access = "out-of-reach";
        const said = await githubRepoReach("ana", REPO);
        expect(said).toContain("cannot see acme/widgets");
        expect(refused).toEqual([]);
    });

    it("names single sign-on when that is what is in the way", async () => {
        link("ana", { id: "c1", provider: "github", label: "ana", method: "oauth" }, { accessToken: "gho_ana" });
        access = "sso-required";
        expect(await githubRepoReach("ana", REPO)).toContain("single sign-on");
    });

    // GitHub being unreachable, rate-limited or slow is not somebody's token
    // expiring, and a deploy must not be refused over it.
    it("lets the deploy try when GitHub itself could not answer", async () => {
        link("ana", { id: "c1", provider: "github", label: "ana", method: "oauth" }, { accessToken: "gho_ana" });
        access = "unknown";
        expect(await githubRepoReach("ana", REPO)).toBeNull();
    });
});
