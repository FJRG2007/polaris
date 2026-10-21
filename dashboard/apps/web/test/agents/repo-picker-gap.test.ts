/**
 * The Agents repository picker offers a pasted repository GitHub refuses only
 * because Polaris's App is not on its owner, so the dialog can show the install
 * step; the other pickers, which draw no such step, keep offering nothing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

let gap: unknown = null;

vi.mock("@/lib/github-access", () => ({
    githubCredentialsForUser: async () => [],
    githubTokenForUser: async () => "user-token",
    listReposForUser: async () => []
}));
vi.mock("@/lib/github-service", () => ({
    resolveGithubRepo: async () => null,
    searchGithubRepos: async () => []
}));
vi.mock("@/lib/github-app-reach", () => ({
    githubInstallGapForRepo: async () => gap
}));

const { pickerRepoSearch } = await import("@/lib/github-repo-picker");

beforeEach(() => {
    gap = null;
});

describe("a pasted repository the App cannot reach", () => {
    it("is offered to the Agents picker when the App is why", async () => {
        gap = { kind: "app-missing", owner: "bytehide", url: null };
        expect(
            await pickerRepoSearch("user-1", "https://github.com/bytehide/Backend", {
                installGaps: true
            })
        ).toEqual([{ fullName: "bytehide/Backend", defaultBranch: "main", private: true }]);
    });

    it("is not offered to pickers that draw no install step", async () => {
        gap = { kind: "app-missing", owner: "bytehide", url: null };
        expect(await pickerRepoSearch("user-1", "bytehide/Backend")).toEqual([]);
    });

    it("is not offered when the App is not the reason", async () => {
        expect(await pickerRepoSearch("user-1", "bytehide/Backend", { installGaps: true })).toEqual(
            []
        );
    });
});
