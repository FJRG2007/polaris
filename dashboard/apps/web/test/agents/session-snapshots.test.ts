/**
 * Per-turn snapshots and undo/redo of a session's checkout.
 *
 * The scripts are run for real, with `sh` and `git`, against a throwaway
 * checkout: a turn is a snapshot followed by the edits an agent would make, and
 * every step is checked against the files on disk and the agent's own git state,
 * which a snapshot must never touch.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as snapshots from "@/lib/agents/session-snapshots";

const DAEMON_CAP = 16 * 1024;

function run(script: string): string {
    return execFileSync("sh", ["-c", script], { encoding: "utf8" }).slice(0, DAEMON_CAP);
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
    const id = "a".repeat(40);

    it("reads a listing, newest first, with the undo point", () => {
        const label = snapshots.turnLabel("fix the  login\nbutton");
        const listing = snapshots.parseTurns(`noise\npolaris-snapshots: list ${id}\n${id} 1700000000 ${label}\nbad line\n`);
        expect(listing).toEqual({ turns: [{ id, at: 1_700_000_000_000, label: "fix the login button" }], undone: id });
        expect(snapshots.parseTurns("polaris-snapshots: list -\n")).toEqual({ turns: [], undone: null });
        expect(snapshots.parseTurns("nothing")).toBeNull();
    });

    it("keeps a label short and on one line", () => {
        const long = Buffer.from(snapshots.turnLabel("x".repeat(500)), "base64").toString("utf8");
        expect(long).toHaveLength(snapshots.LABEL_CHARS);
    });

    it("reads every step answer and refuses a malformed one", () => {
        expect(snapshots.parseStep(`polaris-snapshots: undone ${id}`)).toEqual({ kind: "undone", id });
        expect(snapshots.parseStep("polaris-snapshots: restored")).toEqual({ kind: "restored" });
        expect(snapshots.parseStep("polaris-snapshots: empty")).toEqual({ kind: "empty" });
        expect(snapshots.parseStep("polaris-snapshots: undone nothex")).toBeNull();
        expect(snapshots.parseCapture(`polaris-snapshots: kept ${id} ${snapshots.turnLabel("hi")}`)).toEqual({
            kind: "kept",
            id,
            undoneLabel: "hi"
        });
        expect(snapshots.parseCapture("polaris-snapshots: failed")).toEqual({ kind: "failed" });
    });

    it("names the undone message for the agent", () => {
        expect(snapshots.undoneNote("add tests")).toContain('"add tests"');
    });

    it("never pastes a target that is not a commit name into the script", () => {
        expect(snapshots.undoScript({ workdir: "/w", to: "x; rm -rf /" })).not.toContain("rm -rf /");
    });
});

describe("against a real checkout", () => {
    let root: string;
    let repo: string;
    const read = (name: string) => (existsSync(join(repo, name)) ? readFileSync(join(repo, name), "utf8") : null);
    const capture = (prompt: string) => snapshots.parseCapture(run(snapshots.captureScript({ workdir: repo, prompt })));
    const list = () => snapshots.parseTurns(run(snapshots.listTurnsScript({ workdir: repo })))!;
    const undo = (to?: string) => snapshots.parseStep(run(snapshots.undoScript({ workdir: repo, to })));
    const redo = () => snapshots.parseStep(run(snapshots.redoScript({ workdir: repo })));

    beforeAll(() => {
        root = mkdtempSync(join(tmpdir(), "polaris-snapshots-"));
        repo = join(root, "repo");
        mkdirSync(repo);
        git(repo, "init", "-q", "-b", "main");
        writeFileSync(join(repo, ".gitignore"), "node_modules/\n");
        writeFileSync(join(repo, "a.txt"), "one\n");
        git(repo, "add", "-A");
        git(repo, "commit", "-q", "-m", "start");
    });

    afterAll(() => rmSync(root, { recursive: true, force: true }));

    it("says when there is nothing yet", () => {
        expect(list()).toEqual({ turns: [], undone: null });
        expect(undo()).toEqual({ kind: "empty" });
        expect(redo()).toEqual({ kind: "empty" });
    });

    it("undoes and redoes turns without touching the agent's git state", () => {
        const head = git(repo, "rev-parse", "HEAD");
        const status = () => git(repo, "status", "--porcelain");

        expect(capture("turn one")?.kind).toBe("captured");
        writeFileSync(join(repo, "a.txt"), "two\n");
        writeFileSync(join(repo, "b.txt"), "new\n");
        mkdirSync(join(repo, "node_modules"));
        writeFileSync(join(repo, "node_modules", "dep.js"), "kept\n");

        expect(capture("turn two")?.kind).toBe("captured");
        writeFileSync(join(repo, "a.txt"), "three\n");
        const before = status();

        const turns = list().turns;
        expect(turns.map((turn) => turn.label)).toEqual(["turn two", "turn one"]);

        expect(undo()?.kind).toBe("undone");
        expect(read("a.txt")).toBe("two\n");
        expect(read("b.txt")).toBe("new\n");

        expect(undo()?.kind).toBe("undone");
        expect(read("a.txt")).toBe("one\n");
        expect(read("b.txt")).toBeNull();
        // Ignored files are neither saved nor put back.
        expect(read("node_modules/dep.js")).toBe("kept\n");
        expect(list().undone).toBe(turns[1]!.id);
        expect(undo()).toEqual({ kind: "empty" });

        expect(redo()?.kind).toBe("undone");
        expect(read("a.txt")).toBe("two\n");
        expect(redo()).toEqual({ kind: "restored" });
        expect(read("a.txt")).toBe("three\n");
        expect(list().undone).toBeNull();
        expect(status()).toBe(before);
        expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    }, 180_000);

    it("undoes straight to a picked turn, and keeps the undo on the next prompt", () => {
        const turns = list().turns;
        expect(undo(turns[1]!.id)?.kind).toBe("undone");
        expect(read("a.txt")).toBe("one\n");

        const kept = capture("turn three");
        expect(kept).toMatchObject({ kind: "kept", undoneLabel: "turn one" });
        // The undone turns left the chain; the new one starts it again.
        expect(list()).toEqual({ turns: [expect.objectContaining({ label: "turn three" })], undone: null });
        expect(redo()).toEqual({ kind: "empty" });
        expect(read("a.txt")).toBe("one\n");
    });

    it("takes a hook's report of a prompt just snapshotted as the same turn", () => {
        const newest = list().turns[0]!;
        expect(capture("[Polaris: note] turn three")).toEqual({ kind: "captured", id: newest.id });
        writeFileSync(join(repo, "a.txt"), "typed\n");
        expect(capture("typed in the terminal")?.kind).toBe("captured");
        expect(list().turns.map((turn) => turn.label)).toEqual(["typed in the terminal", "turn three"]);
    });

    it("refuses a turn that is not on the chain", () => {
        expect(undo("b".repeat(40))).toEqual({ kind: "stale" });
    });

    it("answers nocheckout away from a repository", () => {
        expect(snapshots.parseStep(run(snapshots.undoScript({ workdir: join(root, "missing") })))).toEqual({ kind: "nocheckout" });
    });
});
