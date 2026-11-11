/**
 * The review loop: what a reader of a session's diff or its pull request's
 * checks sends back to the agent.
 *
 * What is pinned: a unified diff keeps each side's line numbers, comments
 * become one prompt grouped by file with the line quoted, a check counts as
 * failing only once it finished badly, and only the failing ones are sent.
 */

import { describe, expect, it } from "vitest";
import { translatorFor } from "@/lib/i18n/translate";
import type { PullCheck } from "@/lib/github-service";
import {
    checkFailed,
    checksTally,
    failingChecksPrompt,
    parseUnifiedDiff,
    reviewPrompt
} from "@/lib/agents/session-review-loop";

const DIFF = [
    "diff --git a/src/a.ts b/src/a.ts",
    "--- a/src/a.ts",
    "+++ b/src/a.ts",
    "@@ -10,3 +10,3 @@ export function a() {",
    " const one = 1;",
    "-const two = 2;",
    "+const two = 3;",
    " return one + two;",
    "\\ No newline at end of file",
    ""
].join("\n");

describe("parseUnifiedDiff", () => {
    it("numbers each side from the hunk header", () => {
        const lines = parseUnifiedDiff(DIFF);
        expect(lines.map((line) => line.kind)).toEqual([
            "meta",
            "meta",
            "meta",
            "hunk",
            "context",
            "remove",
            "add",
            "context",
            "meta"
        ]);
        expect(lines[4]).toMatchObject({ oldLine: 10, newLine: 10 });
        expect(lines[5]).toMatchObject({ oldLine: 11, newLine: null });
        expect(lines[6]).toMatchObject({ oldLine: null, newLine: 11 });
        expect(lines[7]).toMatchObject({ oldLine: 12, newLine: 12 });
    });

    it("reads an empty diff as nothing to comment on", () => {
        expect(parseUnifiedDiff("").every((line) => line.kind === "meta")).toBe(true);
    });
});

const WORDS = {
    intro: "Review:",
    line: (line: number) => `line ${line}`,
    removedLine: (line: number) => `removed line ${line}`
};

describe("reviewPrompt", () => {
    it("groups comments by file, quoting each line", () => {
        const text = reviewPrompt(
            [
                { path: "src/a.ts", line: 11, side: "new", code: "+const two = 3;", body: "Why 3?" },
                { path: "src/b.ts", line: 4, side: "old", code: "-keep()", body: "Keep this\nplease" },
                { path: "src/a.ts", line: 12, side: "new", code: " return `x`", body: "ok" }
            ],
            WORDS
        );
        expect(text).toBe(
            [
                "Review:",
                "",
                "src/a.ts:",
                "- line 11: `+const two = 3;`",
                "  Why 3?",
                "- line 12: ` return 'x'`",
                "  ok",
                "",
                "src/b.ts:",
                "- removed line 4: `-keep()`",
                "  Keep this",
                "  please"
            ].join("\n")
        );
    });

    it("is empty when every comment is blank", () => {
        expect(reviewPrompt([{ path: "a", line: 1, side: "new", code: "", body: "  " }], WORDS)).toBe("");
    });

    it("cuts a very long quoted line", () => {
        const text = reviewPrompt(
            [{ path: "a", line: 1, side: "new", code: "x".repeat(5000), body: "min" }],
            WORDS
        );
        expect(text.length).toBeLessThan(400);
    });
});

const check = (over: Partial<PullCheck>): PullCheck => ({
    name: "ci",
    status: "completed",
    conclusion: "success",
    url: null,
    summary: "",
    ...over
});

describe("checks", () => {
    it("counts a finished bad conclusion as failing and nothing else", () => {
        expect(checkFailed(check({ conclusion: "failure" }))).toBe(true);
        expect(checkFailed(check({ conclusion: "timed_out" }))).toBe(true);
        expect(checkFailed(check({ conclusion: "success" }))).toBe(false);
        expect(checkFailed(check({ conclusion: "skipped" }))).toBe(false);
        expect(checkFailed(check({ conclusion: "neutral" }))).toBe(false);
        expect(checkFailed(check({ status: "pending", conclusion: null }))).toBe(false);
    });

    it("tallies passed, failed and pending", () => {
        expect(
            checksTally([
                check({}),
                check({ conclusion: "failure" }),
                check({ status: "pending", conclusion: null }),
                check({ conclusion: "skipped" })
            ])
        ).toEqual({ passed: 2, failed: 1, pending: 1 });
    });

    it("sends only the failing checks, with their summary or the fallback", () => {
        const text = failingChecksPrompt(
            [
                check({ name: "lint" }),
                check({ name: "test", conclusion: "failure", url: "https://example.test/1", summary: "2 failed" }),
                check({ name: "build", conclusion: "cancelled" })
            ],
            { intro: "Failed:", noSummary: "(none)" }
        );
        expect(text).toBe(
            [
                "Failed:",
                "",
                "## test (failure)",
                "https://example.test/1",
                "2 failed",
                "",
                "## build (cancelled)",
                "(none)"
            ].join("\n")
        );
        expect(failingChecksPrompt([check({})], { intro: "x", noSummary: "y" })).toBe("");
    });
});

describe("review loop words", () => {
    const keys = [
        "session.review.waiting",
        "session.review.send",
        "session.checks.tally",
        "session.checks.sendFailing",
        "session.merge.title",
        "session.merge.errors.notAllowed",
        "issueSessions.started",
        "issueSessions.pullOpened"
    ] as const;

    it.each(["en-US", "es-ES"] as const)("are written in %s", (locale) => {
        const t = translatorFor(locale, "agents") as unknown as (key: string, values?: object) => string;
        for (const key of keys) {
            const said = t(key, { count: 2, files: 1, passed: 1, failed: 1, pending: 0, number: 7, url: "u", branch: "b" });
            expect(said, key).not.toContain(key);
            expect(said.length, key).toBeGreaterThan(0);
        }
        expect(t("session.review.waiting", { count: 2, files: 1 })).toMatch(/2/);
    });
});
