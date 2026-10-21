/**
 * Which repository an address names, how a ref and a path are split, when a
 * turn is about a repository, and what a repository step row says.
 */

import { describe, expect, it } from "vitest";
import {
    aboutRepository,
    parseRepoAddress,
    parseRepoInput,
    refCandidates,
    repoStepOf,
    reposInText
} from "@/lib/polar/code-host";
import { fenceScreen } from "@/lib/polar/shared";

describe("reading a repository address", () => {
    it.each([
        ["https://github.com/acme/backend", "github", "acme", "backend", null, []],
        [
            "https://github.com/acme/backend/tree/master",
            "github",
            "acme",
            "backend",
            "tree",
            ["master"]
        ],
        ["https://www.github.com/a/b.git", "github", "a", "b", null, []],
        [
            "github.com/a/b/blob/main/src/app.ts",
            "github",
            "a",
            "b",
            "blob",
            ["main", "src", "app.ts"]
        ],
        [
            "https://github.com/a/b/tree/release/2.x/lib",
            "github",
            "a",
            "b",
            "tree",
            ["release", "2.x", "lib"]
        ],
        ["https://github.com/a/b/issues/12", "github", "a", "b", null, []],
        ["https://github.com/a/b/tree/", "github", "a", "b", null, []],
        ["https://github.com/a/b?tab=readme#top", "github", "a", "b", null, []],
        [
            "https://raw.githubusercontent.com/a/b/main/composer.json",
            "github",
            "a",
            "b",
            "blob",
            ["main", "composer.json"]
        ],
        ["https://gitlab.com/gitlab-org/gitlab", "gitlab", "gitlab-org", "gitlab", null, []],
        ["https://gitlab.com/a/b/c/project", "gitlab", "a/b/c", "project", null, []],
        [
            "https://gitlab.com/a/b/c/project/-/tree/main/app",
            "gitlab",
            "a/b/c",
            "project",
            "tree",
            ["main", "app"]
        ],
        [
            "https://gitlab.com/a/project/-/blob/v1.0/README.md",
            "gitlab",
            "a",
            "project",
            "blob",
            ["v1.0", "README.md"]
        ],
        ["https://gitlab.com/a/project/-/merge_requests/3", "gitlab", "a", "project", null, []],
        ["https://gitlab.com/a/project.git", "gitlab", "a", "project", null, []]
    ])("%s", (address, host, owner, name, kind, rest) => {
        expect(parseRepoAddress(address)).toEqual({ host, owner, name, kind, rest });
    });

    it.each([
        "https://github.com/settings/profile",
        "https://github.com/acme",
        "https://github.com/search?q=x",
        "https://gitlab.com/explore/projects",
        "https://gitlab.com/justauser",
        "https://bitbucket.org/a/b",
        "https://example.com/a/b",
        "ftp://github.com/a/b",
        "not a url at all",
        "https://github.com/a/b%2"
    ])("names no repository: %s", (address) => {
        expect(parseRepoAddress(address)).toBeNull();
    });

    it("takes GitHub's owner/repo shorthand from a tool, but not a bare host", () => {
        expect(parseRepoInput("acme/backend")).toMatchObject({
            host: "github",
            owner: "acme",
            name: "backend"
        });
        expect(parseRepoInput("example.org/x")).toBeNull();
        expect(parseRepoInput("https://gitlab.com/g/s/p")).toMatchObject({
            host: "gitlab",
            owner: "g/s"
        });
    });
});

describe("splitting a ref from a path", () => {
    it("tries the shortest ref first, up to four segments", () => {
        expect(refCandidates(["release", "2.x", "lib", "a", "b"])).toEqual([
            { ref: "release", path: "2.x/lib/a/b" },
            { ref: "release/2.x", path: "lib/a/b" },
            { ref: "release/2.x/lib", path: "a/b" },
            { ref: "release/2.x/lib/a", path: "b" }
        ]);
        expect(refCandidates(["main"])).toEqual([{ ref: "main", path: "" }]);
        expect(refCandidates([])).toEqual([]);
    });
});

describe("when a turn is about a repository", () => {
    const asked = (text: string) => [{ role: "user", parts: [{ type: "text", text }] }];

    it("is when the page shared is one", () => {
        expect(aboutRepository("https://github.com/acme/backend/tree/master", [])).toBe(true);
        expect(aboutRepository("https://news.example.com/", asked("what php version?"))).toBe(
            false
        );
    });

    it("is when the person wrote a repository's address", () => {
        expect(aboutRepository(undefined, asked("look at https://gitlab.com/a/b, please."))).toBe(
            true
        );
        expect(aboutRepository(undefined, asked("see github.com/settings"))).toBe(false);
        // An assistant naming one is not the person asking about it.
        expect(
            aboutRepository(undefined, [
                { role: "assistant", parts: [{ type: "text", text: "https://github.com/a/b" }] }
            ])
        ).toBe(false);
    });

    it("finds every repository in a text once, without trailing punctuation", () => {
        const found = reposInText(
            "Compare https://github.com/a/b. and github.com/a/b/tree/x with (https://gitlab.com/g/p)"
        );
        expect(found.map((repo) => `${repo.host}:${repo.owner}/${repo.name}`)).toEqual([
            "github:a/b",
            "gitlab:g/p"
        ]);
    });

    it("tells the model on the screen note which repository the page is", () => {
        const note = fenceScreen({
            route: "",
            site: { url: "https://github.com/acme/backend/tree/master", title: "backend" }
        } as never);
        expect(note).toContain("GitHub repository acme/backend");
        const plain = fenceScreen({
            route: "",
            site: { url: "https://example.com/", title: "Example" }
        } as never);
        expect(plain).not.toContain("repository");
    });
});

describe("a repository step row", () => {
    it("names the repository and the path or query", () => {
        expect(
            repoStepOf("repo_read_file", {
                repository: "https://github.com/a/b",
                path: "composer.json"
            })
        ).toEqual({
            kind: "read",
            repo: "a/b",
            detail: "composer.json"
        });
        expect(
            repoStepOf("repo_read_file", {
                repository: "https://github.com/a/b/blob/main/Dockerfile"
            })?.detail
        ).toBe("Dockerfile");
        expect(repoStepOf("repo_search", { repository: "a/b", query: "*.csproj" })).toEqual({
            kind: "search",
            repo: "a/b",
            detail: "*.csproj"
        });
        expect(
            repoStepOf("repo_overview", { repository: "https://gitlab.com/g/s/p" })?.detail
        ).toBe("g/s/p");
        expect(repoStepOf("read_page", { url: "https://github.com/a/b" })).toBeNull();
        expect(repoStepOf("repo_commits", null)).toEqual({ kind: "commits", repo: "", detail: "" });
    });
});
