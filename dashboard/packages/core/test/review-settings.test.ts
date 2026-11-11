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

describe("mentionRefusal", () => {
    const mention = { actor: "eve", publicRepo: true, canWrite: false, answeredThisHour: 0 };

    it("refuses an ignored login before anything else", () => {
        expect(core.mentionRefusal(settings({ ignoreMentionsFrom: ["Eve"] }), { ...mention, canWrite: true })).toBe(
            "ignored"
        );
    });

    it("keeps strangers out of public repositories unless allowed", () => {
        expect(core.mentionRefusal(settings(), mention)).toBe("stranger");
        expect(core.mentionRefusal(settings(), { ...mention, canWrite: true })).toBeNull();
        expect(core.mentionRefusal(settings({ mentionsFromAnyone: true }), mention)).toBeNull();
        expect(core.mentionRefusal(settings(), { ...mention, publicRepo: false, canWrite: null })).toBeNull();
    });

    it("stops at the hourly limit, and zero is none", () => {
        const many = { ...mention, canWrite: true, answeredThisHour: 50 };
        expect(core.mentionRefusal(settings({ mentionsPerHour: 50 }), many)).toBe("limit");
        expect(core.mentionRefusal(settings(), many)).toBeNull();
    });
});

describe("reviewInstructions", () => {
    it("adds nothing when every setting is at its default", () => {
        expect(core.reviewInstructions(core.DEFAULT_REVIEW)).toBe("");
        expect(core.recipeInstructions(core.DEFAULT_REVIEW)).toBe("");
    });

    it("words each extra the operator turned on", () => {
        const text = core.reviewInstructions(
            settings({
                profile: "chill",
                walkthrough: true,
                collapseWalkthrough: true,
                suggestLabels: true,
                applyLabels: true,
                titleCheck: "error",
                docstringCheck: "warning",
                docstringThreshold: 60,
                customChecks: [{ name: "Changelog", instructions: "CHANGELOG.md has an entry.", level: "error" }],
                pathFilters: ["dist/**"],
                pathInstructions: [{ path: "src/api/**", instructions: "Check every input is validated." }]
            })
        );
        expect(text).toContain("Skip style nitpicks");
        expect(text).toContain("<details><summary>Walkthrough</summary>");
        expect(text).toContain("apply them with `add_labels`");
        expect(text).toMatch(/Title: .*request changes/);
        expect(text).toMatch(/at least 60% .*as a warning/);
        expect(text).toContain("Changelog: CHANGELOG.md has an entry.");
        expect(text).toContain("`dist/**`");
        expect(text).toContain("For files matching `src/api/**`: Check every input is validated.");
    });

    it("leaves a check that is off out", () => {
        const text = core.reviewInstructions(
            settings({ customChecks: [{ name: "Off one", instructions: "x", level: "off" }], titleCheck: "off" })
        );
        expect(text).toBe("");
    });

    it("lists recipes by name", () => {
        const text = core.recipeInstructions(
            settings({ recipes: [{ name: "add tests", instructions: "Write unit tests for the change." }] })
        );
        expect(text).toContain('"add tests": Write unit tests for the change.');
    });
});

describe("the repository file, for the output settings", () => {
    it("reads nested lists of objects in YAML's names", () => {
        const read = core.reviewSettingsFromFile({
            reviews: {
                profile: "assertive",
                path_instructions: [{ path: "**/*.sql", instructions: "Look for missing indexes." }],
                custom_checks: [{ name: "No TODO", instructions: "No TODO left.", level: "warning" }]
            }
        });
        expect(read?.profile).toBe("assertive");
        expect(read?.pathInstructions).toEqual([{ path: "**/*.sql", instructions: "Look for missing indexes." }]);
        expect(read?.customChecks?.[0]?.level).toBe("warning");
    });
});

describe("rows still being typed", () => {
    it("drops a row with a blank field instead of refusing the tier", () => {
        const parsed = core.reviewSettingsSchema.parse({
            recipes: [
                { name: "add tests", instructions: "Write unit tests." },
                { name: "half", instructions: " " },
                { name: "", instructions: "" }
            ]
        });
        expect(parsed.recipes).toEqual([{ name: "add tests", instructions: "Write unit tests." }]);
    });

    it("still refuses a row that is not a row", () => {
        expect(core.reviewSettingsSchema.safeParse({ recipes: ["text"] }).success).toBe(false);
    });
});
