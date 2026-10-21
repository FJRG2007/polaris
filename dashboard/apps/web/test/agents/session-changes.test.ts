/**
 * Reading what a session changed.
 *
 * The scripts are run for real, with `sh` and `git`, against a throwaway
 * repository shaped like a session's clone: a remote, a branch cut from it, a
 * commit on the branch, an edit not committed and a file never added. Every
 * answer is cut at 16 KiB before it is parsed, which is what the daemon does to
 * a command's output, so a script that relied on printing more would fail here.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
    DIFF_CHUNK_BYTES,
    MAX_DIFF_BYTES,
    fileDiffScript,
    listChangesScript,
    parseChangesList,
    parseDiffChunk,
    parseNumstatLine,
    readFileDiff,
    safeChangePath
} from "@/lib/agents/session-changes";

/** What the host daemon hands back of a command's output. */
const DAEMON_CAP = 16 * 1024;

function run(script: string): string {
    const output = execFileSync("sh", ["-c", script], { encoding: "utf8" });
    return output.slice(0, DAEMON_CAP);
}

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

describe("parsing", () => {
    it("reads numstat lines, binary ones included", () => {
        expect(parseNumstatLine("3\t1\tsrc/a b.ts")).toEqual({ added: 3, removed: 1, path: "src/a b.ts" });
        expect(parseNumstatLine("-\t-\tlogo.png")).toEqual({ added: null, removed: null, path: "logo.png" });
        expect(parseNumstatLine("garbage")).toBeNull();
    });

    it("reads a page and where the next one starts", () => {
        const listing = parseChangesList(
            ["noise", "polaris-changes: ok abc123 3", "1\t0\ta", "2\t2\tb", "polaris-changes: more 2"].join("\n")
        );
        expect(listing).toEqual({
            kind: "ok",
            base: "abc123",
            total: 3,
            files: [
                { added: 1, removed: 0, path: "a" },
                { added: 2, removed: 2, path: "b" }
            ],
            next: 2
        });
        expect(parseChangesList("polaris-changes: nocheckout")).toEqual({ kind: "nocheckout" });
        expect(parseChangesList("polaris-changes: nobase")).toEqual({ kind: "nobase" });
        expect(parseChangesList("nothing at all")).toBeNull();
    });

    it("refuses a chunk that is not base64 rather than decoding garbage", () => {
        expect(parseDiffChunk("polaris-changes: chunk 10\nnot base64!")).toBeNull();
        expect(parseDiffChunk("polaris-changes: large 999999")).toEqual({ kind: "large", size: 999999 });
    });

    it("only reads paths inside the checkout", () => {
        expect(safeChangePath("src/app.ts")).toBe(true);
        expect(safeChangePath("a b/ñ.md")).toBe(true);
        for (const path of ["", "/etc/passwd", "../secret", "a/../../b", "-rf", "a//b", "a\nb", "x\u0000"]) {
            expect(safeChangePath(path)).toBe(false);
        }
    });
});

describe("reading a diff in chunks", () => {
    const encode = (size: number, bytes: Buffer) => `polaris-changes: chunk ${size}\n${bytes.toString("base64")}\n`;

    it("joins chunks back into the whole diff, a character split across two included", async () => {
        const text = `@@ -1 +1 @@\n+${"é".repeat(DIFF_CHUNK_BYTES)}\n`;
        const all = Buffer.from(text, "utf8");
        const offsets: number[] = [];
        const diff = await readFileDiff(async (offset) => {
            offsets.push(offset);
            return encode(all.length, all.subarray(offset, offset + DIFF_CHUNK_BYTES));
        });
        expect(diff).toEqual({ kind: "diff", text });
        expect(offsets).toEqual([0, DIFF_CHUNK_BYTES, DIFF_CHUNK_BYTES * 2]);
    });

    it("fails rather than showing a diff with a hole when a chunk comes back short", async () => {
        const all = Buffer.alloc(DIFF_CHUNK_BYTES * 2, "a");
        const diff = await readFileDiff(async (offset) =>
            encode(all.length, all.subarray(offset, offset + (offset === 0 ? 100 : DIFF_CHUNK_BYTES)))
        );
        expect(diff).toEqual({ kind: "failed" });
    });

    const versioned = (all: Buffer, sum: string, offset: number) =>
        `polaris-changes: chunk ${all.length} ${sum}\n${all.subarray(offset, offset + DIFF_CHUNK_BYTES).toString("base64")}\n`;

    it("reads again from the start when the diff changes between chunks", async () => {
        const before = Buffer.alloc(DIFF_CHUNK_BYTES * 2, "a");
        const after = Buffer.alloc(DIFF_CHUNK_BYTES * 2, "b");
        const offsets: number[] = [];
        const diff = await readFileDiff(async (offset) => {
            offsets.push(offset);
            return offsets.length === 1 ? versioned(before, "1", offset) : versioned(after, "2", offset);
        });
        expect(diff).toEqual({ kind: "diff", text: after.toString("utf8") });
        expect(offsets).toEqual([0, DIFF_CHUNK_BYTES, 0, DIFF_CHUNK_BYTES]);
    });

    it("gives up on a diff that keeps changing rather than splicing it", async () => {
        const all = Buffer.alloc(DIFF_CHUNK_BYTES * 2, "a");
        let call = 0;
        const diff = await readFileDiff(async (offset) => versioned(all, String(++call), offset));
        expect(diff).toEqual({ kind: "failed" });
    });

    it("passes on what the script said instead of a chunk", async () => {
        expect(await readFileDiff(async () => "polaris-changes: gone")).toEqual({ kind: "gone" });
        expect(await readFileDiff(async () => "")).toEqual({ kind: "failed" });
    });
});

// Real processes: each chunk is a shell and a dozen git calls, which on a
// loaded Windows machine is seconds rather than milliseconds.
describe("against a real checkout", { timeout: 120_000 }, () => {
    let root = "";
    let work = "";

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "polaris-changes-"));
        const origin = join(root, "origin.git");
        const seed = join(root, "seed");
        git(root, "init", "-q", "--bare", "-b", "main", origin);
        git(root, "init", "-q", "-b", "main", seed);
        writeFileSync(join(seed, "kept.txt"), "one\ntwo\n");
        writeFileSync(join(seed, "gone.txt"), "bye\n");
        git(seed, "add", "-A");
        git(seed, "commit", "-q", "-m", "seed");
        git(seed, "push", "-q", origin, "main");
        work = join(root, "work");
        git(root, "clone", "-q", "--branch", "main", origin, work);
        git(work, "checkout", "-q", "-b", "polaris/session");
        writeFileSync(join(work, "kept.txt"), "one\nTWO\nthree\n");
        git(work, "rm", "-q", "gone.txt");
        git(work, "commit", "-q", "-m", "agent work");
        // Not committed, and never added.
        writeFileSync(join(work, "kept.txt"), "one\nTWO\nthree\nfour\n");
        writeFileSync(join(work, "new file.md"), "# hello\n");
        writeFileSync(join(work, "big.txt"), `${"x".repeat(99)}\n`.repeat(Math.ceil(MAX_DIFF_BYTES / 100) + 10));
        writeFileSync(join(work, "mid.txt"), `${"y".repeat(99)}\n`.repeat(400));
    }, 120_000);

    afterAll(() => {
        if (root) rmSync(root, { recursive: true, force: true });
    });

    const diffOf = (path: string) =>
        readFileDiff(async (offset) => run(fileDiffScript({ workdir: work, baseRef: "main", path, offset })));

    it("lists committed, uncommitted and untracked changes against the base", () => {
        const listing = parseChangesList(run(listChangesScript({ workdir: work, baseRef: "main", offset: 0 })));
        expect(listing?.kind).toBe("ok");
        if (listing?.kind !== "ok") return;
        const byPath = Object.fromEntries(listing.files.map((file) => [file.path, file]));
        expect(byPath["kept.txt"]).toEqual({ path: "kept.txt", added: 3, removed: 1 });
        expect(byPath["gone.txt"]).toEqual({ path: "gone.txt", added: 0, removed: 1 });
        expect(byPath["new file.md"]).toEqual({ path: "new file.md", added: 1, removed: 0 });
        expect(listing.total).toBe(5);
        expect(listing.next).toBeNull();
    });

    it("finds the base from origin/HEAD when the session recorded none", () => {
        const listing = parseChangesList(run(listChangesScript({ workdir: work, baseRef: "", offset: 0 })));
        expect(listing?.kind).toBe("ok");
    });

    it("pages from an offset", () => {
        const listing = parseChangesList(run(listChangesScript({ workdir: work, baseRef: "main", offset: 3 })));
        expect(listing?.kind === "ok" && listing.files.length).toBe(2);
    });

    it("diffs a tracked file, a deleted one and an untracked one", async () => {
        const kept = await diffOf("kept.txt");
        expect(kept.kind).toBe("diff");
        expect(kept.kind === "diff" && kept.text).toContain("+four");
        const gone = await diffOf("gone.txt");
        expect(gone.kind === "diff" && gone.text).toContain("-bye");
        const added = await diffOf("new file.md");
        expect(added.kind === "diff" && added.text).toContain("+# hello");
    });

    it("reads a diff bigger than the daemon's cap whole, through chunks", async () => {
        const mid = await diffOf("mid.txt");
        expect(mid.kind).toBe("diff");
        if (mid.kind !== "diff") return;
        expect(mid.text.length).toBeGreaterThan(DAEMON_CAP);
        expect(mid.text.match(/^\+y+$/gm)).toHaveLength(400);
    });

    it("says a huge diff is too large instead of reading it", async () => {
        expect((await diffOf("big.txt")).kind).toBe("large");
    });

    it("refuses a path that is neither tracked nor untracked", async () => {
        expect(await diffOf("missing.txt")).toEqual({ kind: "gone" });
    });

    it("says so when there is no checkout", () => {
        const missing = join(root, "nowhere");
        expect(parseChangesList(run(listChangesScript({ workdir: missing, baseRef: "main", offset: 0 })))).toEqual({
            kind: "nocheckout"
        });
    });
});
