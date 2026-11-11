/**
 * Which pull requests the repository bot reviews on its own: tiers resolve
 * nearest first, a stored column this build cannot read inherits, the
 * repository's file reads in YAML's names, and every filter the screen describes
 * holds.
 */

import { describe, expect, it } from "vitest";
import * as core from "../src/index.js";

const pr = (over: Partial<core.ReviewCandidate> = {}): core.ReviewCandidate => ({
    draft: false,
    title: "Add the export button",
    author: "dana",
    baseBranch: "main",
    labels: [],
    ...over
});

const settings = (over: Partial<core.ResolvedReview> = {}): core.ResolvedReview => ({ ...core.DEFAULT_REVIEW, ...over });

describe("resolveReview", () => {
    it("takes the nearest tier with an opinion, field by field", () => {
        const resolved = core.resolveReview(
            { ...core.INHERIT_REVIEW, drafts: true },
            { ...core.INHERIT_REVIEW, drafts: false, labels: ["review"] },
            { ...core.INHERIT_REVIEW, incremental: true }
        );
        expect(resolved.drafts).toBe(true);
        expect(resolved.labels).toEqual(["review"]);
        expect(resolved.incremental).toBe(true);
        expect(resolved.pauseAfter).toBe(core.DEFAULT_REVIEW.pauseAfter);
    });

    it("treats a list as an answer, not an addition", () => {
        const resolved = core.resolveReview({ ...core.INHERIT_REVIEW, labels: [] }, { ...core.INHERIT_REVIEW, labels: ["x"] });
        expect(resolved.labels).toEqual([]);
    });

    it("keeps new pushes unreviewed by default, as before the settings existed", () => {
        expect(core.resolveReview().incremental).toBe(false);
        expect(core.resolveReview().drafts).toBe(false);
        expect(core.resolveReview().configSource).toBe("saved");
    });
});

describe("parseReviewSettings", () => {
    it("inherits everything it cannot read", () => {
        expect(core.parseReviewSettings(null)).toEqual(core.INHERIT_REVIEW);
        expect(core.parseReviewSettings("not json")).toEqual(core.INHERIT_REVIEW);
        expect(core.parseReviewSettings('{"drafts":"yes","pauseAfter":-1,"configSource":"cloud"}')).toEqual(
            core.INHERIT_REVIEW
        );
    });

    it("keeps the fields it can", () => {
        const read = core.parseReviewSettings('{"drafts":true,"labels":["a","!b"],"pauseAfter":3,"configSource":"branch"}');
        expect(read).toMatchObject({ drafts: true, labels: ["a", "!b"], pauseAfter: 3, configSource: "branch" });
    });

    it("calls a block of nulls empty", () => {
        expect(core.reviewSettingsEmpty(core.INHERIT_REVIEW)).toBe(true);
        expect(core.reviewSettingsEmpty({ ...core.INHERIT_REVIEW, drafts: false })).toBe(false);
    });
});

describe("reviewSettingsFromFile", () => {
    it("reads YAML's names, at the top or under reviews", () => {
        const flat = core.reviewSettingsFromFile({ drafts: true, base_branches: ["main"], pause_after: 2 });
        expect(flat).toMatchObject({ drafts: true, baseBranches: ["main"], pauseAfter: 2, configSource: null });
        const nested = core.reviewSettingsFromFile({ reviews: { ignore_authors: ["bot"] } });
        expect(nested?.ignoreAuthors).toEqual(["bot"]);
    });

    it("ignores keys it does not know and refuses a wrong type", () => {
        expect(core.reviewSettingsFromFile({ drafts: true, tone: "friendly" })?.drafts).toBe(true);
        expect(core.reviewSettingsFromFile({ drafts: "yes" })).toBeNull();
    });
});

describe("branchMatches", () => {
    it.each([
        ["main", "main", true],
        ["main", "mainline", false],
        ["release/*", "release/1.2", true],
        ["release/*", "release/1/hotfix", false],
        ["release/**", "release/1/hotfix", true],
        ["*", "feature/x", false],
        ["**", "feature/x", true],
        ["v*.x", "v2.x", true]
    ])("%s against %s is %s", (pattern, branch, expected) => {
        expect(core.branchMatches(pattern, branch)).toBe(expected);
    });
});

describe("reviewSkip", () => {
    it("reviews an ordinary pull request", () => {
        expect(core.reviewSkip(settings(), pr())).toBeNull();
    });

    it("skips drafts unless drafts are reviewed", () => {
        expect(core.reviewSkip(settings(), pr({ draft: true }))).toBe("draft");
        expect(core.reviewSkip(settings({ drafts: true }), pr({ draft: true }))).toBeNull();
    });

    it("skips listed authors and title words in any case", () => {
        expect(core.reviewSkip(settings({ ignoreAuthors: ["Dependabot[bot]"] }), pr({ author: "dependabot[bot]" }))).toBe(
            "author"
        );
        expect(core.reviewSkip(settings({ ignoreTitleKeywords: ["wip"] }), pr({ title: "WIP: export" }))).toBe("title");
    });

    it("keeps to the listed base branches", () => {
        const only = settings({ baseBranches: ["main", "release/*"] });
        expect(core.reviewSkip(only, pr({ baseBranch: "release/3" }))).toBeNull();
        expect(core.reviewSkip(only, pr({ baseBranch: "develop" }))).toBe("branch");
    });

    it("needs a wanted label and none of the excluded ones", () => {
        const labels = settings({ labels: ["needs-review", "!skip-review"] });
        expect(core.reviewSkip(labels, pr({ labels: [] }))).toBe("label");
        expect(core.reviewSkip(labels, pr({ labels: ["Needs-Review"] }))).toBeNull();
        expect(core.reviewSkip(labels, pr({ labels: ["needs-review", "skip-review"] }))).toBe("label");
        expect(core.reviewSkip(settings({ labels: ["!skip-review"] }), pr())).toBeNull();
    });
});
