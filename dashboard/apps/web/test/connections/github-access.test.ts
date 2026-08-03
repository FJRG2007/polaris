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

vi.mock("@/lib/github-service", () => ({
    cloneAuthHeader: (token: string | null) => (token ? `Authorization: Basic ${token}` : null),
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

const { githubCloneAuthHeader, githubCredentialsForUser, githubTokenForOwner, githubTokenForUser, listReposForUser } =
    await import("@/lib/github-access");

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
        expect(await githubCloneAuthHeader("ana", "acme")).toBe("Authorization: Basic instance-token");
    });

    it("clones anonymously rather than with somebody else's credential", async () => {
        installationToken = null;
        link("bruno", { id: "c9", provider: "github", label: "bruno", method: "oauth" }, { accessToken: "gho_bruno" });
        expect(await githubCloneAuthHeader("ana", "acme")).toBeNull();
    });
});
