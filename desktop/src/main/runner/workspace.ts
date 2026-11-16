/**
 * Answers to `workspace.read`: what a session screen reads from a checkout on
 * this computer - its files, one file, the changes since the branch started
 * and one file's diff. The same answers a container session gives from the
 * commands in `session-files.ts` and `session-changes.ts`, read here with git
 * run as an argument array and the file system.
 *
 * Every path the server names is relative to the session's checkout and has
 * to stay inside it: no absolute path, no `..`, nothing under `.git`, and a
 * file read only when its real path (symbolic links followed) is still inside
 * the checkout's real path.
 *
 * Pure apart from `WorkspaceDeps`, so it is tested with a fake git.
 */

import { safeRef } from "./launch";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { WORKSPACE_LIMITS, type WorkspaceAnswer, type WorkspaceQuery } from "../../../../dashboard/packages/core/src/runner-protocol";

/** What git printed, kept up to a cap. `total` counts every byte it printed. */
export interface GitOutput {
    readonly code: number;
    readonly stdout: Buffer;
    readonly total: number;
}

export interface GitReadOptions {
    readonly cwd: string;
    readonly env: Record<string, string>;
    /** Bytes of stdout kept; the rest is read and counted, not kept. */
    readonly maxBytes: number;
    /** How long git may run before it is stopped; a short default when unset. */
    readonly timeoutMs?: number;
}

export interface WorkspaceDeps {
    /** Run git with an argument array and keep its stdout up to a cap. */
    readonly gitRead: (args: string[], options: GitReadOptions) => Promise<GitOutput>;
    /** The real path, symbolic links followed; throws for a missing one. */
    readonly realpath: (path: string) => Promise<string>;
    /** Size and kind without following a link at the end. Null when missing. */
    readonly lstat: (path: string) => Promise<{ size: number; file: boolean; } | null>;
    /** Up to `maxBytes` of a file from its start. */
    readonly readHead: (path: string, maxBytes: number) => Promise<Buffer>;
    /** Newlines in a file, or null when it is binary (a NUL early on). */
    readonly countLines: (path: string) => Promise<number | null>;
}

/** The checkout a running session works in. */
export interface Checkout {
    readonly workdir: string;
    readonly env: Record<string, string>;
}

/** A NUL in this many leading bytes makes a file binary, as git decides. */
export const BINARY_PROBE_BYTES = 8000;
/** Output of a git command that lists changed or untracked files. */
const LIST_OUTPUT_BYTES = 16 * 1024 * 1024;
/** Output of a git command that only names a commit or a ref. */
const SHORT_OUTPUT_BYTES = 4096;

/** The longest path the protocol carries. */
const MAX_PATH = 4096;

/**
 * A path the server named, checked to stay inside the checkout: forward
 * slashes, no absolute path or drive, no `.` / `..` segment, no `.git`, no
 * control character. Null when it does not qualify.
 */
export function checkoutRelative(path: string): string | null {
    if (!path || path.length > MAX_PATH || /[\u0000-\u001f]/.test(path)) return null;
    if (isAbsolute(path) || path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return null;
    const segments = path.split(/[\\/]/);
    for (const segment of segments) {
        if (segment === "" || segment === "." || segment === "..") return null;
        if (segment.toLowerCase() === ".git") return null;
    }
    return segments.join("/");
}

function within(parent: string, child: string): boolean {
    const rel = relative(parent, child);
    return rel === "" || (!isAbsolute(rel) && rel.split(sep)[0] !== "..");
}

function gitArgs(args: string[]): string[] {
    return ["-c", "safe.directory=*", "-c", "core.quotePath=false", ...args];
}

function gitEnv(checkout: Checkout): Record<string, string> {
    return { ...checkout.env, GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", GIT_OPTIONAL_LOCKS: "0" };
}

function makeGit(checkout: Checkout, deps: WorkspaceDeps) {
    return (args: string[], maxBytes = SHORT_OUTPUT_BYTES) =>
        deps.gitRead(gitArgs(args), { cwd: checkout.workdir, env: gitEnv(checkout), maxBytes });
}

type Git = ReturnType<typeof makeGit>;

function firstLine(output: GitOutput): string {
    return output.code === 0 ? (output.stdout.toString("utf8").split("\n")[0] ?? "").trim() : "";
}

function nulList(output: GitOutput): string[] {
    const text = output.stdout.toString("utf8");
    const entries = text.split("\0");
    // A list cut at the cap ends on a partial name; it is dropped.
    if (output.total > output.stdout.length || !text.endsWith("\0")) entries.pop();
    return entries.filter((entry) => entry.length > 0);
}

/**
 * The commit the branch started from, as `preamble()` in `session-changes.ts`
 * finds it: where HEAD left `origin/<ref>`, `origin/<ref>` itself, or the
 * first entry of the branch's reflog. `nocheckout` when this is no git work
 * tree.
 */
async function findBase(git: Git, baseRef: string): Promise<{ kind: "base"; base: string; } | { kind: "nocheckout"; } | { kind: "nobase"; }> {
    if ((await git(["rev-parse", "--git-dir"])).code !== 0) return { kind: "nocheckout" };
    let ref = baseRef.trim();
    if (!ref) ref = firstLine(await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])).replace(/^origin\//, "");
    let base = "";
    if (ref && safeRef(ref)) {
        base = firstLine(await git(["merge-base", "HEAD", `origin/${ref}`]));
        if (!base) base = firstLine(await git(["rev-parse", "--verify", "--quiet", `origin/${ref}^{commit}`]));
    }
    if (!base) {
        const head = firstLine(await git(["symbolic-ref", "--quiet", "--short", "HEAD"]));
        if (head && safeRef(head)) {
            const reflog = await git(["reflog", "show", "--format=%H", `refs/heads/${head}`], LIST_OUTPUT_BYTES);
            const lines = reflog.code === 0 ? reflog.stdout.toString("utf8").split("\n").map((line) => line.trim()).filter(Boolean) : [];
            base = lines[lines.length - 1] ?? "";
        }
    }
    return /^[0-9a-f]{7,64}$/.test(base) ? { kind: "base", base } : { kind: "nobase" };
}

async function listFiles(git: Git): Promise<WorkspaceAnswer> {
    const listed = await git(["ls-files", "-co", "--exclude-standard", "-z"], WORKSPACE_LIMITS.listBytes);
    if (listed.code !== 0) return { kind: "nocheckout" };
    const unique = [...new Set(nulList(listed).filter((path) => path.length <= MAX_PATH))];
    const cut = listed.total > listed.stdout.length;
    return { kind: "files", paths: unique.slice(0, WORKSPACE_LIMITS.files), truncated: cut || unique.length > WORKSPACE_LIMITS.files };
}

async function readFile(checkout: Checkout, raw: string, deps: WorkspaceDeps): Promise<WorkspaceAnswer> {
    const path = checkoutRelative(raw);
    if (!path) return { kind: "gone", path: raw.slice(0, MAX_PATH) || "?" };
    let root: string;
    let target: string;
    try {
        root = await deps.realpath(checkout.workdir);
    } catch {
        return { kind: "nocheckout" };
    }
    try {
        target = await deps.realpath(resolve(checkout.workdir, path));
    } catch {
        return { kind: "gone", path };
    }
    if (!within(root, target)) return { kind: "gone", path };
    const stat = await deps.lstat(target);
    if (!stat?.file) return { kind: "gone", path };
    if (stat.size > WORKSPACE_LIMITS.fileBytes) return { kind: "tooLarge", path, bytes: stat.size };
    const bytes = await deps.readHead(target, WORKSPACE_LIMITS.fileBytes);
    if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return { kind: "binary", path };
    return { kind: "text", path, text: bytes.toString("utf8").slice(0, WORKSPACE_LIMITS.fileBytes) };
}

/** An untracked file's line count, null when binary; never read outside the
 *  checkout or through a link. */
async function untrackedCount(checkout: Checkout, path: string, deps: WorkspaceDeps): Promise<number | null> {
    const safe = checkoutRelative(path);
    if (!safe) return 0;
    const full = resolve(checkout.workdir, safe);
    if (!within(resolve(checkout.workdir), full)) return 0;
    const stat = await deps.lstat(full).catch(() => null);
    if (!stat?.file) return 0;
    return deps.countLines(full).catch(() => 0);
}

async function listChanges(checkout: Checkout, git: Git, baseRef: string, offset: number, deps: WorkspaceDeps): Promise<WorkspaceAnswer> {
    const found = await findBase(git, baseRef);
    if (found.kind !== "base") return found;
    const tracked: { path: string; added: number | null; removed: number | null; }[] = [];
    const numstat = await git(["diff", "--numstat", "--no-renames", "-z", found.base, "--"], LIST_OUTPUT_BYTES);
    if (numstat.code === 0) {
        for (const entry of nulList(numstat)) {
            const match = /^(-|\d+)\t(-|\d+)\t([\s\S]+)$/.exec(entry);
            if (!match || match[3]!.length > MAX_PATH) continue;
            const count = (value: string) => (value === "-" ? null : Number(value));
            tracked.push({ path: match[3]!, added: count(match[1]!), removed: count(match[2]!) });
        }
    }
    const others = await git(["ls-files", "--others", "--exclude-standard", "-z"], LIST_OUTPUT_BYTES);
    const untracked = others.code === 0 ? nulList(others).filter((path) => path.length <= MAX_PATH) : [];
    const total = tracked.length + untracked.length;
    const start = Math.min(offset, total);
    const end = Math.min(total, start + WORKSPACE_LIMITS.changesPage);
    const files: { path: string; added: number | null; removed: number | null; }[] = [];
    for (let index = start; index < end; index++) {
        if (index < tracked.length) files.push(tracked[index]!);
        else {
            const path = untracked[index - tracked.length]!;
            const lines = await untrackedCount(checkout, path, deps);
            files.push({ path, added: lines, removed: lines === null ? null : 0 });
        }
    }
    return { kind: "changes", base: found.base, total, files, next: end < total ? end : null };
}

async function readDiff(git: Git, baseRef: string, raw: string): Promise<WorkspaceAnswer> {
    const path = checkoutRelative(raw);
    const found = await findBase(git, baseRef);
    if (found.kind !== "base") return found;
    if (!path) return { kind: "gone", path: raw.slice(0, MAX_PATH) || "?" };
    let diff: GitOutput;
    const known = (await git(["ls-files", "--error-unmatch", "--", path])).code === 0 || (await git(["cat-file", "-e", `${found.base}:${path}`])).code === 0;
    if (known) diff = await git(["diff", "--no-renames", "--no-color", found.base, "--", path], WORKSPACE_LIMITS.diffBytes);
    else {
        const others = await git(["ls-files", "--others", "--exclude-standard", "-z", "--", path], SHORT_OUTPUT_BYTES + MAX_PATH);
        if (!nulList(others).includes(path)) return { kind: "gone", path };
        // `--no-index` exits 1 when the files differ, which they always do here.
        diff = await git(["diff", "--no-index", "--no-color", "--", "/dev/null", path], WORKSPACE_LIMITS.diffBytes);
    }
    if (diff.total > WORKSPACE_LIMITS.diffBytes) return { kind: "diffLarge", size: diff.total };
    const text = diff.stdout.toString("utf8");
    if (/^Binary files .* differ$/m.test(text) && !/^@@ /m.test(text)) return { kind: "binary", path };
    return { kind: "diff", text: text.slice(0, WORKSPACE_LIMITS.diffBytes) };
}

/** One `workspace.read` answered for a session's checkout, or `missing` when
 *  this computer holds no such session. */
export async function readWorkspace(checkout: Checkout | null, query: WorkspaceQuery, deps: WorkspaceDeps): Promise<WorkspaceAnswer> {
    if (!checkout) return { kind: "missing" };
    const git = makeGit(checkout, deps);
    switch (query.kind) {
        case "files":
            return listFiles(git);
        case "file":
            return readFile(checkout, query.path, deps);
        case "changes":
            return listChanges(checkout, git, query.baseRef, query.offset, deps);
        case "diff":
            return readDiff(git, query.baseRef, query.path);
    }
}
