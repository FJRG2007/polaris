/**
 * Reading a commit out of whatever somebody pasted.
 *
 * This is the one piece of the commit link that parses untrusted text, so it is
 * the one worth pinning: what it accepts decides which repository Polaris then
 * asks GitHub about, and a sloppy pattern here is how a link to some other
 * host's "github.com" path ends up being treated as a repository.
 */

import { describe, expect, it } from "vitest";
import { parseGithubCommit } from "@/lib/repo-reference";

describe("parseGithubCommit", () => {
    it("reads the URL from the browser bar", () => {
        expect(parseGithubCommit("https://github.com/FJRG2007/polaris/commit/9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3")).toEqual({
            owner: "FJRG2007",
            repo: "polaris",
            sha: "9f1c2ab3d4e5f60718293a4b5c6d7e8f90a1b2c3"
        });
    });

    it("reads the shorthand people type in chat", () => {
        expect(parseGithubCommit("FJRG2007/polaris@9f1c2ab")).toEqual({
            owner: "FJRG2007",
            repo: "polaris",
            sha: "9f1c2ab"
        });
    });

    it("accepts the API's plural path and normalises the sha", () => {
        expect(parseGithubCommit("https://github.com/o/r/commits/ABCDEF1234567")?.sha).toBe("abcdef1234567");
    });

    it("ignores surrounding whitespace", () => {
        expect(parseGithubCommit("  https://github.com/o/r/commit/abc1234  ")?.repo).toBe("r");
    });

    it("refuses what is not a commit", () => {
        expect(parseGithubCommit("")).toBeNull();
        expect(parseGithubCommit("https://github.com/FJRG2007/polaris")).toBeNull();
        expect(parseGithubCommit("https://github.com/FJRG2007/polaris/pull/12")).toBeNull();
        // Too short to be a sha: seven is the shortest GitHub itself renders.
        expect(parseGithubCommit("o/r@abc12")).toBeNull();
        expect(parseGithubCommit("just some words")).toBeNull();
    });
});
