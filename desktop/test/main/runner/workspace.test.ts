import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { checkoutRelative, readWorkspace, type GitOutput, type WorkspaceDeps } from "@/main/runner/workspace";
import { WORKSPACE_LIMITS, workspaceAnswerSchema } from "../../../../dashboard/packages/core/src/runner-protocol";

const BASE = "a".repeat(40);

let root: string;
let outside: string;

beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "runner-workspace-"));
    outside = await mkdtemp(join(tmpdir(), "runner-outside-"));
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src", "app.ts"), "one\ntwo\n");
    await writeFile(join(root, "image.bin"), Buffer.from([1, 2, 0, 3]));
    await writeFile(join(root, "big.txt"), "x".repeat(WORKSPACE_LIMITS.fileBytes + 1));
    await writeFile(join(root, "new.txt"), "a\nb\nc\n");
    await writeFile(join(outside, "secret.txt"), "secret");
    try {
        await symlink(join(outside, "secret.txt"), join(root, "escape.txt"), "file");
    } catch {
        // Symbolic links need a privilege on Windows; the test that uses one checks for it.
    }
});

afterAll(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
});

function out(text: string | Buffer, code = 0, total?: number): GitOutput {
    const stdout = typeof text === "string" ? Buffer.from(text) : text;
    return { code, stdout, total: total ?? stdout.length };
}

/** A fake git: answers by the command words after the `-c` options. */
function fakeGit(answers: Record<string, GitOutput | ((maxBytes: number) => GitOutput)>) {
    const calls: { args: string[]; env: Record<string, string>; maxBytes: number; }[] = [];
    const gitRead: WorkspaceDeps["gitRead"] = async (args, options) => {
        calls.push({ args, env: options.env, maxBytes: options.maxBytes });
        const words = args.slice(4).join(" ");
        const answer = answers[words];
        if (!answer) return out("", 128);
        return typeof answer === "function" ? answer(options.maxBytes) : answer;
    };
    return { gitRead, calls };
}

function deps(gitRead: WorkspaceDeps["gitRead"]): WorkspaceDeps {
    return {
        gitRead,
        realpath: (path) => realpath(path),
        lstat: async (path) => {
            const stat = await lstat(path).catch(() => null);
            return stat ? { size: stat.size, file: stat.isFile() } : null;
        },
        readHead: async (path, maxBytes) => (await readFile(path)).subarray(0, maxBytes),
        countLines: async (path) => {
            const bytes = await readFile(path);
            return bytes.subarray(0, 8000).includes(0) ? null : bytes.toString("utf8").split("\n").length - 1;
        }
    };
}

const repo = {
    "rev-parse --git-dir": out(".git\n"),
    "merge-base HEAD origin/main": out(`${BASE}\n`)
};

function checkout() {
    return { workdir: root, env: { PATH: "/tc/bin" } };
}

describe("checkoutRelative", () => {
    it.each(["src/app.ts", "a b/c.txt", "src\\app.ts"])("keeps %s", (path) => {
        expect(checkoutRelative(path)).not.toBeNull();
    });

    it.each(["", "/etc/passwd", "\\\\server\\share", "C:/Windows/win.ini", "c:file", "../up.txt", "src/../../up", "./a", "a//b", ".git/config", "sub/.GIT/config", "a\u0000b", "a\nb"])(
        "refuses %j",
        (path) => {
            expect(checkoutRelative(path)).toBeNull();
        }
    );
});

describe("readWorkspace", () => {
    it("answers missing for a session this computer does not hold", async () => {
        const git = fakeGit({});
        expect(await readWorkspace(null, { kind: "files" }, deps(git.gitRead))).toEqual({ kind: "missing" });
        expect(git.calls).toEqual([]);
    });

    it("lists files from NUL-separated output, without duplicates, on the session's env", async () => {
        const git = fakeGit({ "ls-files -co --exclude-standard -z": out("src/app.ts\0new.txt\0src/app.ts\0odd\nname\0") });
        const answer = await readWorkspace(checkout(), { kind: "files" }, deps(git.gitRead));
        expect(answer).toEqual({ kind: "files", paths: ["src/app.ts", "new.txt", "odd\nname"], truncated: false });
        expect(git.calls[0]!.args.slice(0, 4)).toEqual(["-c", "safe.directory=*", "-c", "core.quotePath=false"]);
        expect(git.calls[0]!.env).toMatchObject({ PATH: "/tc/bin", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1" });
        expect(git.calls[0]!.maxBytes).toBe(WORKSPACE_LIMITS.listBytes);
        expect(workspaceAnswerSchema.safeParse(answer).success).toBe(true);
    });

    it("says a list cut at the cap was cut and drops the partial name", async () => {
        const git = fakeGit({ "ls-files -co --exclude-standard -z": out("a.txt\0b.txt\0par", 0, WORKSPACE_LIMITS.listBytes + 50) });
        expect(await readWorkspace(checkout(), { kind: "files" }, deps(git.gitRead))).toEqual({ kind: "files", paths: ["a.txt", "b.txt"], truncated: true });
    });

    it("answers nocheckout for a folder git does not know", async () => {
        const git = fakeGit({});
        expect(await readWorkspace(checkout(), { kind: "files" }, deps(git.gitRead))).toEqual({ kind: "nocheckout" });
        expect(await readWorkspace(checkout(), { kind: "changes", baseRef: "main", offset: 0 }, deps(git.gitRead))).toEqual({ kind: "nocheckout" });
    });

    it("reads a text file, names a binary and a large one, and a missing one is gone", async () => {
        const d = deps(fakeGit({}).gitRead);
        expect(await readWorkspace(checkout(), { kind: "file", path: "src/app.ts" }, d)).toEqual({ kind: "text", path: "src/app.ts", text: "one\ntwo\n" });
        expect(await readWorkspace(checkout(), { kind: "file", path: "image.bin" }, d)).toEqual({ kind: "binary", path: "image.bin" });
        expect(await readWorkspace(checkout(), { kind: "file", path: "big.txt" }, d)).toEqual({ kind: "tooLarge", path: "big.txt", bytes: WORKSPACE_LIMITS.fileBytes + 1 });
        expect(await readWorkspace(checkout(), { kind: "file", path: "nope.txt" }, d)).toEqual({ kind: "gone", path: "nope.txt" });
        expect(await readWorkspace(checkout(), { kind: "file", path: "src" }, d)).toEqual({ kind: "gone", path: "src" });
    });

    it("never reads outside the checkout", async () => {
        const d = deps(fakeGit({}).gitRead);
        const escape = join("..", outside.split(/[\\/]/).pop()!, "secret.txt");
        for (const path of [escape, join(outside, "secret.txt"), "../secret.txt"]) {
            const answer = await readWorkspace(checkout(), { kind: "file", path }, d);
            expect(answer.kind).toBe("gone");
        }
        const linked = await lstat(join(root, "escape.txt")).catch(() => null);
        if (linked?.isSymbolicLink()) expect(await readWorkspace(checkout(), { kind: "file", path: "escape.txt" }, d)).toEqual({ kind: "gone", path: "escape.txt" });
    });

    it("lists changes against the merge base, untracked files counted, a page at a time", async () => {
        const git = fakeGit({
            ...repo,
            [`diff --numstat --no-renames -z ${BASE} --`]: out("3\t1\tsrc/app.ts\0-\t-\timage.bin\0"),
            "ls-files --others --exclude-standard -z": out("new.txt\0")
        });
        const answer = await readWorkspace(checkout(), { kind: "changes", baseRef: "main", offset: 0 }, deps(git.gitRead));
        expect(answer).toEqual({
            kind: "changes",
            base: BASE,
            total: 3,
            files: [
                { path: "src/app.ts", added: 3, removed: 1 },
                { path: "image.bin", added: null, removed: null },
                { path: "new.txt", added: 3, removed: 0 }
            ],
            next: null
        });
        expect(workspaceAnswerSchema.safeParse(answer).success).toBe(true);
        expect(await readWorkspace(checkout(), { kind: "changes", baseRef: "main", offset: 2 }, deps(git.gitRead))).toMatchObject({ files: [{ path: "new.txt" }], next: null });
    });

    it("pages a long list of changes", async () => {
        const many = Array.from({ length: WORKSPACE_LIMITS.changesPage + 5 }, (_, index) => `1\t0\tf${index}.txt\0`).join("");
        const git = fakeGit({ ...repo, [`diff --numstat --no-renames -z ${BASE} --`]: out(many), "ls-files --others --exclude-standard -z": out("") });
        const first = await readWorkspace(checkout(), { kind: "changes", baseRef: "main", offset: 0 }, deps(git.gitRead));
        expect(first).toMatchObject({ total: WORKSPACE_LIMITS.changesPage + 5, next: WORKSPACE_LIMITS.changesPage });
        const second = await readWorkspace(checkout(), { kind: "changes", baseRef: "main", offset: WORKSPACE_LIMITS.changesPage }, deps(git.gitRead));
        expect(second).toMatchObject({ next: null });
        expect(second.kind === "changes" && second.files.length).toBe(5);
    });

    it("finds the base from origin/HEAD, then the branch's reflog, else says there is none", async () => {
        const fromHead = fakeGit({
            "rev-parse --git-dir": out(".git\n"),
            "symbolic-ref --quiet --short refs/remotes/origin/HEAD": out("origin/trunk\n"),
            "merge-base HEAD origin/trunk": out(`${BASE}\n`),
            [`diff --numstat --no-renames -z ${BASE} --`]: out(""),
            "ls-files --others --exclude-standard -z": out("")
        });
        expect(await readWorkspace(checkout(), { kind: "changes", baseRef: "", offset: 0 }, deps(fromHead.gitRead))).toMatchObject({ kind: "changes", base: BASE });

        const reflogBase = "b".repeat(40);
        const fromReflog = fakeGit({
            "rev-parse --git-dir": out(".git\n"),
            "symbolic-ref --quiet --short HEAD": out("polar/fix-1\n"),
            "reflog show --format=%H refs/heads/polar/fix-1": out(`${"c".repeat(40)}\n${reflogBase}\n`),
            [`diff --numstat --no-renames -z ${reflogBase} --`]: out(""),
            "ls-files --others --exclude-standard -z": out("")
        });
        expect(await readWorkspace(checkout(), { kind: "changes", baseRef: "gone", offset: 0 }, deps(fromReflog.gitRead))).toMatchObject({ base: reflogBase });

        const none = fakeGit({ "rev-parse --git-dir": out(".git\n") });
        expect(await readWorkspace(checkout(), { kind: "changes", baseRef: "main", offset: 0 }, deps(none.gitRead))).toEqual({ kind: "nobase" });
    });

    it("never hands git a base ref that reads as an option", async () => {
        const git = fakeGit({ "rev-parse --git-dir": out(".git\n") });
        await readWorkspace(checkout(), { kind: "changes", baseRef: "--output=/tmp/x", offset: 0 }, deps(git.gitRead));
        expect(git.calls.some((call) => call.args.some((arg) => arg.includes("--output")))).toBe(false);
    });

    it("diffs a tracked file against the base", async () => {
        const git = fakeGit({
            ...repo,
            "ls-files --error-unmatch -- src/app.ts": out("src/app.ts\n"),
            [`diff --no-renames --no-color ${BASE} -- src/app.ts`]: out("@@ -1 +1 @@\n-a\n+b\n")
        });
        expect(await readWorkspace(checkout(), { kind: "diff", baseRef: "main", path: "src/app.ts" }, deps(git.gitRead))).toEqual({ kind: "diff", text: "@@ -1 +1 @@\n-a\n+b\n" });
    });

    it("diffs an untracked file from nothing, and a file that is neither is gone", async () => {
        const git = fakeGit({
            ...repo,
            "ls-files --others --exclude-standard -z -- new.txt": out("new.txt\0"),
            "diff --no-index --no-color -- /dev/null new.txt": out("@@ -0,0 +1,3 @@\n+a\n+b\n+c\n", 1)
        });
        expect(await readWorkspace(checkout(), { kind: "diff", baseRef: "main", path: "new.txt" }, deps(git.gitRead))).toMatchObject({ kind: "diff" });
        expect(await readWorkspace(checkout(), { kind: "diff", baseRef: "main", path: "other.txt" }, deps(git.gitRead))).toEqual({ kind: "gone", path: "other.txt" });
    });

    it("names a large diff by size and a binary one as binary", async () => {
        const git = fakeGit({
            ...repo,
            "ls-files --error-unmatch -- big.txt": out("big.txt\n"),
            [`diff --no-renames --no-color ${BASE} -- big.txt`]: (maxBytes) => out("x".repeat(maxBytes), 0, 400_000),
            "ls-files --error-unmatch -- image.bin": out("image.bin\n"),
            [`diff --no-renames --no-color ${BASE} -- image.bin`]: out("diff --git a/image.bin b/image.bin\nBinary files a/image.bin and b/image.bin differ\n")
        });
        expect(await readWorkspace(checkout(), { kind: "diff", baseRef: "main", path: "big.txt" }, deps(git.gitRead))).toEqual({ kind: "diffLarge", size: 400_000 });
        expect(await readWorkspace(checkout(), { kind: "diff", baseRef: "main", path: "image.bin" }, deps(git.gitRead))).toEqual({ kind: "binary", path: "image.bin" });
    });

    it("refuses a diff path outside the checkout without running a diff", async () => {
        const git = fakeGit(repo);
        expect(await readWorkspace(checkout(), { kind: "diff", baseRef: "main", path: "../x" }, deps(git.gitRead))).toMatchObject({ kind: "gone" });
        expect(git.calls.some((call) => call.args.includes("diff"))).toBe(false);
    });
});
