/**
 * Reverting a session's change, a whole file or one hunk, run by `sh` against a
 * real git checkout the way the session's machine runs it. Fixture data only.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
    fileDiffScript,
    hunkId,
    parseRevert,
    readFileDiff,
    revertFileScript,
    revertHunkScript,
    splitHunks
} from "@/lib/agents/session-changes";

const run = (script: string) => execFileSync("sh", ["-c", script], { encoding: "utf8" });

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
        cwd,
        encoding: "utf8",
        env: {
            ...process.env,
            GIT_AUTHOR_NAME: "Test",
            GIT_AUTHOR_EMAIL: "test@example.invalid",
            GIT_COMMITTER_NAME: "Test",
            GIT_COMMITTER_EMAIL: "test@example.invalid"
        }
    });
}

const LINES = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);

describe("splitHunks", () => {
    it("cuts a diff into its header and hunks, each named by its text", () => {
        const text = [
            "diff --git a/f b/f",
            "--- a/f",
            "+++ b/f",
            "@@ -1,2 +1,2 @@",
            "-a",
            "+A",
            "@@ -9,1 +9,1 @@",
            "-z",
            "+Z",
            ""
        ].join("\n");
        const { header, hunks } = splitHunks(text);
        expect(header).toBe("diff --git a/f b/f\n--- a/f\n+++ b/f\n");
        expect(hunks.map((hunk) => hunk.text)).toEqual(["@@ -1,2 +1,2 @@\n-a\n+A\n", "@@ -9,1 +9,1 @@\n-z\n+Z\n"]);
        expect(hunks[0]!.id).toBe(hunkId(hunks[0]!.text));
        expect(hunks[0]!.id).toMatch(/^[0-9a-f]{8}$/);
        expect(hunks[0]!.id).not.toBe(hunks[1]!.id);
    });

    it("has no hunks for a diff without any", () => {
        expect(splitHunks("Binary files a/x and b/x differ\n").hunks).toEqual([]);
    });

    it("reads what a revert script said", () => {
        expect(parseRevert("noise\npolaris-changes: reverted\n")).toBe("reverted");
        expect(parseRevert("polaris-changes: stale")).toBe("stale");
        expect(parseRevert("polaris-changes: whatever")).toBeNull();
        expect(parseRevert("")).toBeNull();
    });
});

describe("against a real checkout", { timeout: 120_000 }, () => {
    let root = "";
    let work = "";

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "polaris-revert-"));
        const origin = join(root, "origin.git");
        const seed = join(root, "seed");
        git(root, "init", "-q", "--bare", "-b", "main", origin);
        git(root, "init", "-q", "-b", "main", seed);
        writeFileSync(join(seed, "kept.txt"), `${LINES.join("\n")}\n`);
        writeFileSync(join(seed, "other.txt"), "stays\n");
        git(seed, "add", "-A");
        git(seed, "commit", "-q", "-m", "seed");
        git(seed, "push", "-q", origin, "main");
        work = join(root, "work");
        // A Windows git turns checked-out text into CRLF unless told otherwise.
        git(root, "clone", "-q", "-c", "core.autocrlf=false", "--branch", "main", origin, work);
        git(work, "checkout", "-q", "-b", "polaris/session");
        // Two hunks far apart, one committed and one not.
        const edited = [...LINES];
        edited[1] = "LINE 2";
        writeFileSync(join(work, "kept.txt"), `${edited.join("\n")}\n`);
        git(work, "commit", "-q", "-am", "agent work");
        edited[27] = "LINE 28";
        writeFileSync(join(work, "kept.txt"), `${edited.join("\n")}\n`);
        git(work, "add", "kept.txt");
        writeFileSync(join(work, "added.txt"), "new\n");
        git(work, "add", "added.txt");
        git(work, "commit", "-q", "-m", "more");
        writeFileSync(join(work, "untracked.txt"), "loose\n");
    });

    afterEach(() => {
        if (root) rmSync(root, { recursive: true, force: true });
    });

    const read = (path: string) => readFileSync(join(work, path), "utf8");
    const diffOf = (path: string) =>
        readFileDiff(async (offset) => run(fileDiffScript({ workdir: work, baseRef: "main", path, offset })));
    const revertFile = (path: string) => parseRevert(run(revertFileScript({ workdir: work, baseRef: "main", path })));

    it("puts a changed file back as the base had it", () => {
        expect(revertFile("kept.txt")).toBe("reverted");
        expect(read("kept.txt")).toBe(`${LINES.join("\n")}\n`);
        expect(read("other.txt")).toBe("stays\n");
    });

    it("removes a file the base did not have, tracked or not, and nothing else", () => {
        expect(revertFile("added.txt")).toBe("reverted");
        expect(existsSync(join(work, "added.txt"))).toBe(false);
        expect(revertFile("untracked.txt")).toBe("reverted");
        expect(existsSync(join(work, "untracked.txt"))).toBe(false);
        expect(revertFile("never-there.txt")).toBe("gone");
        expect(existsSync(join(work, "kept.txt"))).toBe(true);
    });

    it("reverts one hunk and keeps the other", async () => {
        const diff = await diffOf("kept.txt");
        expect(diff.kind).toBe("diff");
        if (diff.kind !== "diff") return;
        const { header, hunks } = splitHunks(diff.text);
        expect(hunks).toHaveLength(2);
        const said = parseRevert(
            run(revertHunkScript({ workdir: work, baseRef: "main", patch: header + hunks[1]!.text }))
        );
        expect(said).toBe("reverted");
        const now = read("kept.txt").split("\n");
        expect(now[1]).toBe("LINE 2");
        expect(now[27]).toBe("line 28");
    });

    it("refuses a hunk the file no longer matches instead of applying it elsewhere", async () => {
        const diff = await diffOf("kept.txt");
        if (diff.kind !== "diff") throw new Error("no diff");
        const { header, hunks } = splitHunks(diff.text);
        // The agent wrote over those lines after the diff was read.
        writeFileSync(join(work, "kept.txt"), "something else entirely\n");
        const said = parseRevert(
            run(revertHunkScript({ workdir: work, baseRef: "main", patch: header + hunks[0]!.text }))
        );
        expect(said).toBe("stale");
        expect(read("kept.txt")).toBe("something else entirely\n");
    });

    it("quotes a path with shell characters as one argument", () => {
        const odd = "a b;$(touch pwned).txt";
        writeFileSync(join(work, odd), "x\n");
        expect(revertFile(odd)).toBe("reverted");
        expect(existsSync(join(work, odd))).toBe(false);
        expect(existsSync(join(work, "pwned"))).toBe(false);
    });
});
