import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { runSnapshot, type SnapshotDeps } from "@/main/runner/snapshots";
import { snapshotAnswerSchema } from "../../../../dashboard/packages/core/src/runner-protocol";
import type { GitOutput, GitReadOptions } from "@/main/runner/workspace";

/** Real git, as the runner runs it: an argument array and no shell. */
function gitRead(args: string[], options: GitReadOptions): Promise<GitOutput> {
    return new Promise((resolve) => {
        const child = spawn("git", args, { cwd: options.cwd, env: { ...process.env, ...options.env }, stdio: ["ignore", "pipe", "ignore"] });
        const chunks: Buffer[] = [];
        child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
        child.once("error", () => resolve({ code: 127, stdout: Buffer.alloc(0), total: 0 }));
        child.once("close", (code) => {
            const stdout = Buffer.concat(chunks);
            resolve({ code: code ?? 1, stdout: stdout.subarray(0, options.maxBytes), total: stdout.length });
        });
    });
}

const deps: SnapshotDeps = {
    gitRead,
    exists: async (path) => (await stat(path).catch(() => null)) !== null,
    mkdir: async (path) => {
        await mkdir(path, { recursive: true });
    },
    copyFile: (from, to) => copyFile(from, to).then(() => true, () => false),
    writeFile: (path, text) => writeFile(path, text)
};

let root: string;
const checkout = () => ({ workdir: root, env: {} });
const read = (name: string) => readFile(join(root, name), "utf8");

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "runner-snapshots-"));
    await gitRead(["init", "-q"], { cwd: root, env: {}, maxBytes: 4096 });
    await writeFile(join(root, ".gitignore"), "node_modules/\n");
    await writeFile(join(root, "app.ts"), "one\n");
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("runner snapshots", () => {
    it("undoes a turn, redoes it, and keeps an undo when the next turn starts", { timeout: 60_000 }, async () => {
        const first = await runSnapshot(checkout(), { kind: "capture", label: "Write two" }, deps);
        expect(first.kind).toBe("captured");
        expect(snapshotAnswerSchema.safeParse(first).success).toBe(true);
        await writeFile(join(root, "app.ts"), "two\n");
        await mkdir(join(root, "node_modules"));
        await writeFile(join(root, "node_modules", "dep.js"), "kept");

        const undone = await runSnapshot(checkout(), { kind: "undo" }, deps);
        expect(undone).toEqual({ kind: "undone", id: (first as { id: string }).id });
        expect(await read("app.ts")).toBe("one\n");
        // Ignored files are neither saved nor put back.
        expect(await read("node_modules/dep.js")).toBe("kept");

        const listing = await runSnapshot(checkout(), { kind: "list" }, deps);
        expect(listing).toMatchObject({ kind: "list", undone: (first as { id: string }).id, turns: [{ label: "Write two" }] });

        expect(await runSnapshot(checkout(), { kind: "redo" }, deps)).toEqual({ kind: "restored" });
        expect(await read("app.ts")).toBe("two\n");

        await runSnapshot(checkout(), { kind: "undo" }, deps);
        const next = await runSnapshot(checkout(), { kind: "capture", label: "Write three" }, deps);
        expect(next).toMatchObject({ kind: "kept", undoneLabel: "Write two" });
        expect(await runSnapshot(checkout(), { kind: "redo" }, deps)).toEqual({ kind: "empty" });
    });

    it("takes the same files just taken as the same turn, and refuses a turn not on the chain", { timeout: 60_000 }, async () => {
        const first = await runSnapshot(checkout(), { kind: "capture", label: "Ask" }, deps);
        const again = await runSnapshot(checkout(), { kind: "capture", label: "[Polaris: note] Ask" }, deps);
        expect(again).toEqual(first);
        expect(await runSnapshot(checkout(), { kind: "undo", to: "b".repeat(40) }, deps)).toEqual({ kind: "stale" });
    });

    it("answers for a session it does not hold or a folder that is no checkout", async () => {
        expect(await runSnapshot(null, { kind: "list" }, deps)).toEqual({ kind: "missing" });
        const bare = await mkdtemp(join(tmpdir(), "runner-nogit-"));
        try {
            expect(await runSnapshot({ workdir: bare, env: { GIT_CEILING_DIRECTORIES: tmpdir() } }, { kind: "list" }, deps)).toEqual({ kind: "nocheckout" });
        } finally {
            await rm(bare, { recursive: true, force: true });
        }
    });
});
