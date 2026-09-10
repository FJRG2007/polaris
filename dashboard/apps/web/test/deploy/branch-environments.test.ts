/**
 * Branch environments and pull request previews.
 *
 * Three rules the feature rests on. A branch environment's branch wins over
 * each service's own, or a staging copy quietly builds production's branch. A
 * name only reaches `git clone --branch` if git itself would accept it. And a
 * pull request from a fork gets no preview: its code would run with this
 * project's variables and secrets.
 */

import { isGitBranchName } from "@polaris/core";
import { describe, expect, it, vi } from "vitest";

const findMany = vi.fn(async () => []);
vi.mock("@polaris/db", () => ({
    prisma: {
        project: { findMany },
        environment: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) }
    }
}));

const { trackedBranch } = await import("@/lib/deploy/branches");
const { ensurePullRequestPreview } = await import("@/lib/deploy/environments");

describe("which branch a service follows", () => {
    const app = (deployBranch: string | null, branch?: string) => ({
        deployBranch,
        sourceConfig: JSON.stringify(branch ? { branch } : {})
    });

    it("follows the environment's branch over the service's own", () => {
        expect(trackedBranch(app("main", "main"), { branch: "staging" })).toBe("staging");
    });

    it("falls back to the auto-deploy branch, then to the branch it was created from", () => {
        expect(trackedBranch(app("release", "main"), { branch: null })).toBe("release");
        expect(trackedBranch(app(null, "main"), { branch: null })).toBe("main");
        expect(trackedBranch(app(null), { branch: "  " })).toBe("");
    });
});

describe("what counts as a branch name", () => {
    it("accepts the names people actually use", () => {
        for (const name of ["main", "feature/login", "release+1", "fix-12_b", "user@feature", "v1.2"]) {
            expect(isGitBranchName(name), name).toBe(true);
        }
    });

    it("refuses anything git would, and anything that reads as an option", () => {
        for (const name of ["-x", "--upload-pack=evil", "a..b", "a b", "a:b", "a~1", "a^", "a/", "/a", "a.lock", "a@{1}", "a//b", ""]) {
            expect(isGitBranchName(name), name).toBe(false);
        }
    });
});

describe("a pull request from a fork", () => {
    it("gets no preview, and nothing is even looked up for it", async () => {
        const created = await ensurePullRequestPreview({
            repo: "acme/shop",
            number: 7,
            title: "Add a thing",
            headBranch: "patch-1",
            headSha: "a".repeat(40),
            headRepo: "stranger/shop"
        });
        expect(created).toBe(0);
        expect(findMany).not.toHaveBeenCalled();
    });

    it("gets one looked up when it comes from the repository itself", async () => {
        await ensurePullRequestPreview({
            repo: "acme/shop",
            number: 8,
            title: "Add a thing",
            headBranch: "feature/thing",
            headSha: "b".repeat(40),
            headRepo: "acme/shop"
        });
        expect(findMany).toHaveBeenCalled();
    });
});
