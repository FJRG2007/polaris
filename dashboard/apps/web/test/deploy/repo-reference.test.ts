/**
 * Reading the repository field. The rule being protected: whatever an operator
 * pastes into one box - a browser URL, a clone command's SSH remote, a deep link
 * into a file, or just `owner/repo` - has to name the same repository, and a URL
 * that is not GitHub's must fall through to the plain-git path instead of being
 * mistaken for one.
 */

import { describe, expect, it } from "vitest";
import { externalGitUrl, parseGithubRepo } from "../../src/lib/repo-reference";

describe("parseGithubRepo", () => {
    it("reads every form of the same repository", () => {
        const expected = { owner: "FJRG2007", repo: "polaris" };
        expect(parseGithubRepo("https://github.com/FJRG2007/polaris")).toEqual(expected);
        expect(parseGithubRepo("https://github.com/FJRG2007/polaris.git")).toEqual(expected);
        expect(parseGithubRepo("https://www.github.com/FJRG2007/polaris/")).toEqual(expected);
        expect(parseGithubRepo("github.com/FJRG2007/polaris")).toEqual(expected);
        expect(parseGithubRepo("git@github.com:FJRG2007/polaris.git")).toEqual(expected);
        expect(parseGithubRepo("ssh://git@github.com/FJRG2007/polaris.git")).toEqual(expected);
        expect(parseGithubRepo("FJRG2007/polaris")).toEqual(expected);
        expect(parseGithubRepo("  FJRG2007/polaris  ")).toEqual(expected);
    });

    it("keeps the repository from a link that points deeper into it", () => {
        expect(parseGithubRepo("https://github.com/FJRG2007/polaris/tree/main/dashboard")).toEqual({
            owner: "FJRG2007",
            repo: "polaris"
        });
        expect(parseGithubRepo("https://github.com/FJRG2007/polaris/blob/main/README.md?plain=1")).toEqual({
            owner: "FJRG2007",
            repo: "polaris"
        });
    });

    it("treats a phrase as a phrase, not as a repository", () => {
        expect(parseGithubRepo("")).toBeNull();
        expect(parseGithubRepo("   ")).toBeNull();
        expect(parseGithubRepo("next.js starter")).toBeNull();
        expect(parseGithubRepo("polaris")).toBeNull();
        expect(parseGithubRepo("a/b/c/d")).toBeNull();
        // github.com paths that are pages rather than repositories.
        expect(parseGithubRepo("https://github.com/settings/apps")).toBeNull();
        expect(parseGithubRepo("https://github.com/orgs/vercel")).toBeNull();
    });

    it("refuses names GitHub itself would not accept", () => {
        expect(parseGithubRepo("own er/repo")).toBeNull();
        expect(parseGithubRepo("owner/re po")).toBeNull();
        expect(parseGithubRepo("owner/..")).toBeNull();
    });
});

describe("externalGitUrl", () => {
    it("passes through a clonable URL that is not GitHub", () => {
        expect(externalGitUrl("https://gitlab.com/group/project.git")).toBe(
            "https://gitlab.com/group/project.git"
        );
        expect(externalGitUrl("https://git.example.com/team/app")).toBe("https://git.example.com/team/app");
    });

    it("leaves GitHub to the repository picker", () => {
        expect(externalGitUrl("https://github.com/FJRG2007/polaris")).toBeNull();
        expect(externalGitUrl("https://www.github.com/FJRG2007/polaris")).toBeNull();
    });

    it("rejects what is not a URL to a repository", () => {
        expect(externalGitUrl("gitlab.com/group/project")).toBeNull();
        expect(externalGitUrl("group/project")).toBeNull();
        expect(externalGitUrl("https://gitlab.com")).toBeNull();
        expect(externalGitUrl("https://gitlab.com/")).toBeNull();
    });

    it("refuses a URL carrying credentials, which would be stored in the clear", () => {
        expect(externalGitUrl("https://user:token@gitlab.com/group/project.git")).toBeNull();
    });
});
