/**
 * Build-from-source support: shallow-clone a git repo and tar its contents into a
 * build context stream. The runtime feeds that tar to the build port (the host
 * daemon's `docker build`, or `docker build` over SSH). Public repositories only
 * for now; private-repo auth is a follow-up. The web container needs `git` and
 * `tar` on PATH (added to its image).
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";

export interface GitSource {
    repoUrl: string;
    branch?: string;
}

/** Whether a repo URL is a scheme we will clone (http/https/git, no ssh/file). */
export function isCloneableUrl(url: string): boolean {
    return /^(https?|git):\/\/[^\s]+$/.test(url.trim());
}

/**
 * Return a build-context factory for a git source: each call shallow-clones into a
 * fresh temp dir and streams a tar of it, cleaning the dir up once the tar is fully
 * read. Clone output is streamed to `onOutput` (the deployment log).
 */
export function gitBuildContext(source: GitSource, onOutput: (chunk: Buffer) => void): () => Promise<Readable> {
    if (!isCloneableUrl(source.repoUrl)) {
        throw new Error("Only public http(s)/git repository URLs are supported");
    }
    return async () => {
        const dir = await mkdtemp(join(tmpdir(), "polaris-build-"));
        const args = ["clone", "--depth", "1"];
        if (source.branch) args.push("--branch", source.branch);
        args.push("--", source.repoUrl, dir);
        await runCommand("git", args, onOutput);
        // Tar the working tree (excluding the .git dir) as the build context.
        const child = spawn("tar", ["-C", dir, "--exclude=./.git", "-c", "."]);
        child.stderr.on("data", (chunk: Buffer) => onOutput(chunk));
        const cleanup = (): void => void rm(dir, { recursive: true, force: true });
        child.stdout.on("close", cleanup);
        child.stdout.on("error", cleanup);
        return child.stdout;
    };
}

function runCommand(command: string, args: string[], onOutput: (chunk: Buffer) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args);
        child.stdout.on("data", (chunk: Buffer) => onOutput(chunk));
        child.stderr.on("data", (chunk: Buffer) => onOutput(chunk));
        child.on("error", reject);
        child.on("close", (code) =>
            code === 0 ? resolve() : reject(new Error(`${command} exited with code ${code ?? -1}`))
        );
    });
}
