/**
 * The review loop: what somebody reading the session's diff, or its pull
 * request's checks, sends back to the agent.
 *
 * Pure. The prompt goes through the same path a typed one does
 * (`promptSessionAction` -> `sanitizeAgentPrompt`), so nothing here is a
 * security boundary; it only has to read well to the agent.
 */

import type { PullCheck } from "@/lib/github-service";

/** One line of a unified diff, as the review view draws it. */
export interface DiffLine {
    readonly kind: "add" | "remove" | "context" | "hunk" | "meta";
    readonly text: string;
    /** The line's number in the new file, or null for a removed line or a header. */
    readonly newLine: number | null;
    /** Its number in the old file, or null for an added line or a header. */
    readonly oldLine: number | null;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A unified diff, line by line with each side's line number. */
export function parseUnifiedDiff(text: string): DiffLine[] {
    const lines: DiffLine[] = [];
    let oldAt = 0;
    let newAt = 0;
    let inHunk = false;
    for (const raw of text.replace(/\n$/, "").split("\n")) {
        const hunk = HUNK.exec(raw);
        if (hunk) {
            oldAt = Number(hunk[1]);
            newAt = Number(hunk[2]);
            inHunk = true;
            lines.push({ kind: "hunk", text: raw, newLine: null, oldLine: null });
            continue;
        }
        if (!inHunk || raw.startsWith("\\")) {
            lines.push({ kind: "meta", text: raw, newLine: null, oldLine: null });
            continue;
        }
        if (raw.startsWith("+")) {
            lines.push({ kind: "add", text: raw, newLine: newAt, oldLine: null });
            newAt += 1;
        } else if (raw.startsWith("-")) {
            lines.push({ kind: "remove", text: raw, newLine: null, oldLine: oldAt });
            oldAt += 1;
        } else {
            lines.push({ kind: "context", text: raw, newLine: newAt, oldLine: oldAt });
            newAt += 1;
            oldAt += 1;
        }
    }
    return lines;
}

/** A comment somebody left on a line of the diff. */
export interface LineComment {
    readonly path: string;
    /** The line number on the side it was left on. */
    readonly line: number;
    /** `new` for an added or unchanged line, `old` for a removed one. */
    readonly side: "new" | "old";
    /** The line as it reads in the diff, so the agent sees what was meant even
     *  after it has moved. */
    readonly code: string;
    readonly body: string;
}

/** Past this a quoted line is cut: a minified file's one line is not context. */
const CODE_MAX = 300;

/**
 * Every comment as one prompt, grouped by file in the order they were left.
 * The words are the reader's to supply, since the prompt is shown in the
 * session's conversation as theirs.
 */
export function reviewPrompt(
    comments: readonly LineComment[],
    words: { intro: string; removedLine: (line: number) => string; line: (line: number) => string }
): string {
    const byFile = new Map<string, LineComment[]>();
    for (const comment of comments) {
        if (!comment.body.trim()) continue;
        byFile.set(comment.path, [...(byFile.get(comment.path) ?? []), comment]);
    }
    if (byFile.size === 0) return "";
    const parts = [words.intro];
    for (const [path, list] of byFile) {
        parts.push("", `${path}:`);
        for (const comment of list) {
            const where =
                comment.side === "old" ? words.removedLine(comment.line) : words.line(comment.line);
            const code = comment.code.slice(0, CODE_MAX);
            parts.push(`- ${where}: \`${code.replace(/`/g, "'")}\``);
            for (const said of comment.body.trim().split("\n")) parts.push(`  ${said}`);
        }
    }
    return parts.join("\n");
}

/** Whether a check counts as failing: finished, and not a pass, a skip or neutral. */
export function checkFailed(check: Pick<PullCheck, "status" | "conclusion">): boolean {
    if (check.status !== "completed") return false;
    return !["success", "neutral", "skipped"].includes(check.conclusion ?? "");
}

/** How a pull request's checks stand, counted. */
export function checksTally(checks: readonly Pick<PullCheck, "status" | "conclusion">[]): {
    passed: number;
    failed: number;
    pending: number;
} {
    let passed = 0;
    let failed = 0;
    let pending = 0;
    for (const check of checks) {
        if (check.status !== "completed") pending += 1;
        else if (checkFailed(check)) failed += 1;
        else passed += 1;
    }
    return { passed, failed, pending };
}

/** Past this a check's own summary is cut, and the link is what is left. */
const SUMMARY_MAX = 2000;

/** The failing checks as one prompt, or empty when none failed. */
export function failingChecksPrompt(
    checks: readonly PullCheck[],
    words: { intro: string; noSummary: string }
): string {
    const failing = checks.filter(checkFailed);
    if (failing.length === 0) return "";
    const parts = [words.intro];
    for (const check of failing) {
        parts.push("", `## ${check.name} (${check.conclusion ?? "failure"})`);
        if (check.url) parts.push(check.url);
        const summary = check.summary.trim();
        parts.push(summary ? summary.slice(0, SUMMARY_MAX) : words.noSummary);
    }
    return parts.join("\n").slice(0, 19_000);
}
