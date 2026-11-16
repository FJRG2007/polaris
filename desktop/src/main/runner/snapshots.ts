/**
 * Answers to `snapshot.run`: per-turn snapshots of a session's checkout on this
 * computer, and undo/redo over them - what a container session does with the
 * scripts in `session-snapshots.ts`, done here with git run as an argument
 * array.
 *
 * The technique is the same (OpenCode's `snapshot.ts`): a second git
 * repository at `.git/polaris-snapshots` whose work tree is the checkout, so a
 * snapshot never touches the branch, the index or the history the agent sees.
 * The refs are the same too - `refs/polaris/turns` one commit per turn,
 * `refs/polaris/redo` the files as they were before the first undo, and
 * `refs/polaris/undone` the turn the files stand before - so the server reads
 * both kinds of session alike.
 *
 * Pure apart from `SnapshotDeps`.
 */

import { join, resolve } from "node:path";
import type { Checkout, GitOutput, GitReadOptions } from "./workspace";
import { SNAPSHOT_LIMITS, type SnapshotAction, type SnapshotAnswer } from "../../../../dashboard/packages/core/src/runner-protocol";

export interface SnapshotDeps {
    /** Run git with an argument array and keep its stdout up to a cap. */
    readonly gitRead: (args: string[], options: GitReadOptions) => Promise<GitOutput>;
    readonly exists: (path: string) => Promise<boolean>;
    readonly mkdir: (path: string) => Promise<void>;
    /** Copy a file; resolves false when the source cannot be read. */
    readonly copyFile: (from: string, to: string) => Promise<boolean>;
    readonly writeFile: (path: string, text: string) => Promise<void>;
}

const REF_TURNS = "refs/polaris/turns";
const REF_REDO = "refs/polaris/redo";
const REF_UNDONE = "refs/polaris/undone";

/** Output of a git command that names a commit or a few lines. */
const SHORT_OUTPUT_BYTES = 4096;
/** Output of the turn listing: 40 lines of a hash, a time and a label. */
const LIST_OUTPUT_BYTES = 64 * 1024;

/** How long one git command may take: adding a large checkout to the
 *  snapshot index is slow the first time, and a stopped one leaves a lock. */
const GIT_TIMEOUT_MS = 60_000;

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The label a turn is stored under: the prompt's opening on one line, in
 *  base64, as the container scripts store it. */
export function turnLabel(prompt: string): string {
    const line = prompt.replace(/\s+/g, " ").trim().slice(0, SNAPSHOT_LIMITS.labelChars);
    return Buffer.from(line, "utf8").toString("base64");
}

function decodeLabel(encoded: string): string {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return "";
    return Buffer.from(encoded, "base64").toString("utf8").slice(0, SNAPSHOT_LIMITS.labelChars);
}

function firstLine(output: GitOutput): string {
    return output.code === 0 ? (output.stdout.toString("utf8").split("\n")[0] ?? "").trim() : "";
}

interface Repo {
    /** git in the checkout itself. */
    readonly g: (args: string[], maxBytes?: number) => Promise<GitOutput>;
    /** git on the snapshot repository, its work tree the checkout. */
    readonly s: (args: string[], maxBytes?: number) => Promise<GitOutput>;
    readonly snap: string;
    readonly top: string;
}

function env(checkout: Checkout): Record<string, string> {
    return {
        ...checkout.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_LITERAL_PATHSPECS: "1",
        GIT_AUTHOR_NAME: "Polaris",
        GIT_AUTHOR_EMAIL: "snapshots@polaris.invalid",
        GIT_COMMITTER_NAME: "Polaris",
        GIT_COMMITTER_EMAIL: "snapshots@polaris.invalid"
    };
}

async function openRepo(checkout: Checkout, deps: SnapshotDeps): Promise<Repo | null> {
    const options = (cwd: string, maxBytes: number): GitReadOptions => ({ cwd, env: env(checkout), maxBytes, timeoutMs: GIT_TIMEOUT_MS });
    const inCheckout = (args: string[], maxBytes = SHORT_OUTPUT_BYTES) =>
        deps.gitRead(["-c", "safe.directory=*", ...args], options(checkout.workdir, maxBytes));
    const gd = firstLine(await inCheckout(["rev-parse", "--absolute-git-dir"]));
    const top = firstLine(await inCheckout(["rev-parse", "--show-toplevel"]));
    if (!gd || !top) return null;
    const snap = join(gd, "polaris-snapshots");
    const flags = ["-c", "safe.directory=*", "-c", "core.autocrlf=false", "-c", "core.quotePath=false", "-c", "gc.auto=256"];
    return {
        g: (args, maxBytes = SHORT_OUTPUT_BYTES) => deps.gitRead(["-c", "safe.directory=*", ...args], options(top, maxBytes)),
        s: (args, maxBytes = SHORT_OUTPUT_BYTES) =>
            deps.gitRead([...flags, `--git-dir=${snap}`, `--work-tree=${top}`, ...args], options(top, maxBytes)),
        snap,
        top
    };
}

/** Brings the snapshot index level with the checkout. Only `.gitignore` and
 *  the checkout's own `info/exclude` decide what is left out. */
async function sync(repo: Repo, deps: SnapshotDeps): Promise<boolean> {
    await deps.mkdir(join(repo.snap, "info"));
    const exclude = firstLine(await repo.g(["rev-parse", "--git-path", "info/exclude"]));
    const target = join(repo.snap, "info", "exclude");
    if (!exclude || !(await deps.copyFile(resolve(repo.top, exclude), target))) await deps.writeFile(target, "");
    return (await repo.s(["add", "-A", "--", "."])).code === 0;
}

async function verify(repo: Repo, ref: string): Promise<string> {
    const said = firstLine(await repo.s(["rev-parse", "-q", "--verify", ref]));
    return COMMIT.test(said) ? said : "";
}

async function capture(repo: Repo, label: string, deps: SnapshotDeps): Promise<SnapshotAnswer> {
    if (!(await deps.exists(join(repo.snap, "HEAD")))) {
        if ((await repo.s(["init", "-q"])).code !== 0) return { kind: "failed" };
        if ((await repo.s(["config", "core.bare", "false"])).code !== 0) return { kind: "failed" };
    }
    if (!(await sync(repo, deps))) return { kind: "failed" };
    const tree = firstLine(await repo.s(["write-tree"]));
    if (!COMMIT.test(tree)) return { kind: "failed" };
    let head = await verify(repo, REF_TURNS);
    let kept: string | null = null;
    const undone = await verify(repo, REF_UNDONE);
    if (undone) {
        kept = firstLine(await repo.s(["log", "-1", "--format=%s", undone]));
        head = await verify(repo, `${undone}^`);
        await repo.s(["update-ref", "-d", REF_REDO]);
        await repo.s(["update-ref", "-d", REF_UNDONE]);
    } else if (head && (await isRecentSame(repo, head, tree))) {
        // The same files as the turn just taken: the prompt that a hook
        // reported is the one already snapshotted before it was sent.
        return { kind: "captured", id: head };
    }
    const commit = firstLine(await repo.s(["commit-tree", tree, ...(head ? ["-p", head] : []), "-m", turnLabel(label)]));
    if (!COMMIT.test(commit)) return { kind: "failed" };
    if ((await repo.s(["update-ref", REF_TURNS, commit])).code !== 0) return { kind: "failed" };
    await repo.s(["gc", "--auto", "--quiet"]);
    return kept === null ? { kind: "captured", id: commit } : { kind: "kept", id: commit, undoneLabel: decodeLabel(kept) };
}

/** How recent a turn with the same files has to be to stand for the prompt a
 *  hook reports, in seconds. */
export const SAME_TURN_WINDOW_S = 120;

async function isRecentSame(repo: Repo, head: string, tree: string): Promise<boolean> {
    const [headTree, at] = firstLine(await repo.s(["log", "-1", "--format=%T %ct", head])).split(" ");
    return headTree === tree && Number(at) * 1000 > Date.now() - SAME_TURN_WINDOW_S * 1000;
}

async function list(repo: Repo, deps: SnapshotDeps): Promise<SnapshotAnswer> {
    if (!(await deps.exists(join(repo.snap, "HEAD")))) return { kind: "list", turns: [], undone: null };
    const undone = await verify(repo, REF_UNDONE);
    const log = await repo.s(["log", "-n", String(SNAPSHOT_LIMITS.turns), "--format=%H %ct %s", REF_TURNS], LIST_OUTPUT_BYTES);
    const turns: { id: string; at: number; label: string; }[] = [];
    if (log.code === 0)
        for (const line of log.stdout.toString("utf8").split("\n")) {
            const [id, at, label = ""] = line.trim().split(" ");
            if (!id || !COMMIT.test(id) || !at || !/^\d+$/.test(at)) continue;
            turns.push({ id, at: Number(at) * 1000, label: decodeLabel(label) });
            if (turns.length >= SNAPSHOT_LIMITS.turns) break;
        }
    return { kind: "list", turns, undone: undone || null };
}

async function undo(repo: Repo, to: string | undefined, deps: SnapshotDeps): Promise<SnapshotAnswer> {
    if (!(await deps.exists(join(repo.snap, "HEAD")))) return { kind: "empty" };
    const head = await verify(repo, REF_TURNS);
    if (!head) return { kind: "empty" };
    const undone = await verify(repo, REF_UNDONE);
    let target: string;
    if (to) {
        if (!COMMIT.test(to) || (await repo.s(["merge-base", "--is-ancestor", to, REF_TURNS])).code !== 0) return { kind: "stale" };
        target = to;
    } else if (undone) {
        target = await verify(repo, `${undone}^`);
        if (!target) return { kind: "empty" };
    } else target = head;
    if (!(await sync(repo, deps))) return { kind: "failed" };
    if (!undone) {
        const tree = firstLine(await repo.s(["write-tree"]));
        if (!COMMIT.test(tree)) return { kind: "failed" };
        const saved = firstLine(await repo.s(["commit-tree", tree, "-m", "redo"]));
        if (!COMMIT.test(saved) || (await repo.s(["update-ref", REF_REDO, saved])).code !== 0) return { kind: "failed" };
    }
    if ((await repo.s(["reset", "-q", "--hard", target])).code !== 0) return { kind: "failed" };
    if ((await repo.s(["update-ref", REF_UNDONE, target])).code !== 0) return { kind: "failed" };
    return { kind: "undone", id: target };
}

async function redo(repo: Repo, deps: SnapshotDeps): Promise<SnapshotAnswer> {
    if (!(await deps.exists(join(repo.snap, "HEAD")))) return { kind: "empty" };
    const undone = await verify(repo, REF_UNDONE);
    if (!undone) return { kind: "empty" };
    const next = firstLine(await repo.s(["rev-list", "--reverse", "--ancestry-path", `${undone}..${REF_TURNS}`]));
    if (!(await sync(repo, deps))) return { kind: "failed" };
    if (COMMIT.test(next)) {
        if ((await repo.s(["reset", "-q", "--hard", next])).code !== 0) return { kind: "failed" };
        if ((await repo.s(["update-ref", REF_UNDONE, next])).code !== 0) return { kind: "failed" };
        return { kind: "undone", id: next };
    }
    const saved = await verify(repo, REF_REDO);
    if (!saved) return { kind: "failed" };
    if ((await repo.s(["reset", "-q", "--hard", saved])).code !== 0) return { kind: "failed" };
    await repo.s(["update-ref", "-d", REF_UNDONE]);
    await repo.s(["update-ref", "-d", REF_REDO]);
    return { kind: "restored" };
}

/** Run one snapshot step on a session's checkout. `missing` for a session
 *  this computer does not hold. */
export async function runSnapshot(checkout: Checkout | null, action: SnapshotAction, deps: SnapshotDeps): Promise<SnapshotAnswer> {
    if (!checkout) return { kind: "missing" };
    const repo = await openRepo(checkout, deps);
    if (!repo) return { kind: "nocheckout" };
    switch (action.kind) {
        case "capture":
            return capture(repo, action.label, deps);
        case "list":
            return list(repo, deps);
        case "undo":
            return undo(repo, action.to, deps);
        case "redo":
            return redo(repo, deps);
    }
}
