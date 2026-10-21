/**
 * The script that saves a session's work, run for real against a git
 * repository and a local remote. Only git and a POSIX shell are needed: the
 * remote is a bare repository on disk, so the credential header is carried but
 * never used.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@polaris/db", () => ({ prisma: {} }));
vi.mock("@/lib/deploy/ports-hostd", () => ({ HostdPorts: class {} }));
vi.mock("@/lib/github-service", () => ({}));
vi.mock("@/lib/notifications/dispatch", () => ({ notify: vi.fn() }));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: vi.fn() }));

const { parseSaveWork, pushFailureReason, saveWorkScript } = await import("@/lib/agents/session-work");

// Real git processes, a dozen per test, and slow to spawn on some machines.
vi.setConfig({ testTimeout: 180_000 });

const dirs: string[] = [];
afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const posix = (path: string) => path.replace(/\\/g, "/");

function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A clone on a session branch, whose origin is a bare repository on disk. */
function checkout(): { root: string; work: string; remote: string } {
    const root = mkdtempSync(join(tmpdir(), "polaris-save-"));
    dirs.push(root);
    const remote = join(root, "remote.git");
    const seed = join(root, "seed");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    execFileSync("git", ["init", "-q", "-b", "main", seed]);
    git(seed, "config", "user.email", "fixture@example.test");
    git(seed, "config", "user.name", "Fixture");
    writeFileSync(join(seed, "README.md"), "hello\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "first");
    git(seed, "push", "-q", posix(remote), "main");
    const work = join(root, "work");
    execFileSync("git", ["clone", "-q", posix(remote), work]);
    git(work, "config", "user.email", "fixture@example.test");
    git(work, "config", "user.name", "Fixture");
    git(work, "checkout", "-q", "-b", "polaris/fix");
    return { root, work, remote };
}

function run(work: string, root: string, policy = "restricted", auth = true): ReturnType<typeof parseSaveWork> {
    const authFile = auth ? posix(join(root, "auth")) : "";
    if (auth) writeFileSync(join(root, "auth"), "X-Fixture: yes");
    const script = saveWorkScript({ workdir: posix(work), branch: "polaris/fix", policy, authFile });
    const output = execFileSync("sh", ["-c", script], { encoding: "utf8" });
    return parseSaveWork(output);
}

describe("the save-work script", () => {
    it("reports a clean checkout and pushes nothing", () => {
        const { root, work } = checkout();
        expect(run(work, root)).toMatchObject({ status: "clean", commits: 0, branch: "polaris/fix" });
    });

    it("commits what is dirty and pushes it with the commits before it", () => {
        const { root, work, remote } = checkout();
        writeFileSync(join(work, "a.txt"), "a\n");
        git(work, "add", "-A");
        git(work, "commit", "-q", "-m", "agent commit");
        writeFileSync(join(work, "b.txt"), "left over\n");

        expect(run(work, root)).toMatchObject({ status: "pushed", commits: 2, branch: "polaris/fix" });
        expect(git(remote, "log", "--format=%s", "polaris/fix")).toContain("WIP:");
        expect(git(work, "status", "--porcelain")).toBe("");
    });

    it("refuses to push the default branch when pushes are restricted", () => {
        const { root, work } = checkout();
        git(work, "checkout", "-q", "main");
        writeFileSync(join(work, "c.txt"), "c\n");
        expect(run(work, root)).toMatchObject({ status: "refused", commits: 1, branch: "main" });
    });

    it("pushes nothing at all when the repository is read-only for agents", () => {
        const { root, work } = checkout();
        writeFileSync(join(work, "d.txt"), "d\n");
        expect(run(work, root, "disabled", false)).toMatchObject({ status: "refused", commits: 1 });
    });

    it("never forces over a branch that moved on", () => {
        const { root, work, remote } = checkout();
        const other = join(root, "other");
        execFileSync("git", ["clone", "-q", posix(remote), other]);
        git(other, "config", "user.email", "fixture@example.test");
        git(other, "config", "user.name", "Fixture");
        git(other, "checkout", "-q", "-b", "polaris/fix");
        writeFileSync(join(other, "e.txt"), "e\n");
        git(other, "add", "-A");
        git(other, "commit", "-q", "-m", "elsewhere");
        git(other, "push", "-q", "origin", "polaris/fix");

        writeFileSync(join(work, "f.txt"), "f\n");
        const parsed = run(work, root);
        expect(parsed?.status).toBe("rejected");
        expect(pushFailureReason(parsed!.said)).toBe("rejected");
        expect(git(remote, "log", "--format=%s", "polaris/fix")).toContain("elsewhere");
    });

    it("says there is no credential rather than pushing without one", () => {
        const { root, work } = checkout();
        writeFileSync(join(work, "g.txt"), "g\n");
        expect(run(work, root, "enabled", false)).toMatchObject({ status: "noauth", commits: 1 });
    });

    it("reads only its own last status line", () => {
        expect(parseSaveWork("noise\npolaris-work: pushed 3 polaris/x\n")).toEqual({
            status: "pushed",
            commits: 3,
            branch: "polaris/x",
            said: "noise"
        });
        expect(parseSaveWork("cut off mid-way")).toBeNull();
        expect(parseSaveWork("polaris-work: exploded 1 x")).toBeNull();
    });
});
