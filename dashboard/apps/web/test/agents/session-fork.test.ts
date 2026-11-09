/**
 * Forking a session: what the fork checks out, whether it takes the parent's
 * conversation, and what the launch script does with it in a real shell.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as commands from "@/lib/agents/session-commands";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { forkBaseRef, forkTranscript, type ForkParent } from "@/lib/agents/session-fork";

const TRANSCRIPT = "/home/node/.claude/projects/-work-repo/0f8c2f8e-1c3a-4d55-9a3e-2a1b3c4d5e6f.jsonl";

const parent: ForkParent & { transcriptPath: string | null } = {
    cli: "claude",
    place: "local",
    hostId: null,
    sharedHome: false,
    ownerId: "owner-1",
    branch: "polaris/fix-login-abc123",
    baseRef: "main",
    work: null,
    pullRequest: null,
    transcriptPath: TRANSCRIPT
};

describe("forkBaseRef", () => {
    it("starts from the parent's branch once its work reached GitHub", () => {
        expect(forkBaseRef({ ...parent, work: { state: "pushed" } })).toBe(parent.branch);
        expect(forkBaseRef({ ...parent, pullRequest: { number: 7 } })).toBe(parent.branch);
    });

    it("starts from what the parent started from while its branch exists nowhere else", () => {
        expect(forkBaseRef(parent)).toBe("main");
        expect(forkBaseRef({ ...parent, work: { state: "kept" } })).toBe("main");
    });
});

describe("forkTranscript", () => {
    it("carries a Claude conversation kept in the same home", () => {
        expect(forkTranscript({ ...parent }, parent)).toBe(TRANSCRIPT);
        expect(
            forkTranscript({ ...parent, ownerId: "owner-2", sharedHome: true }, { ...parent, sharedHome: true })
        ).toBe(TRANSCRIPT);
    });

    it("starts fresh where the transcript is out of reach", () => {
        expect(forkTranscript({ ...parent, ownerId: "owner-2" }, parent)).toBe("");
        expect(forkTranscript({ ...parent, sharedHome: true }, parent)).toBe("");
        expect(forkTranscript({ ...parent, place: "host", hostId: "a" }, { ...parent, place: "host", hostId: "b" })).toBe("");
        expect(forkTranscript({ ...parent, ownerId: null }, { ...parent, ownerId: null })).toBe("");
    });

    it("starts fresh for an agent with no documented fork, or a path it cannot trust", () => {
        expect(forkTranscript({ ...parent, cli: "codex" }, { ...parent, cli: "codex" })).toBe("");
        expect(forkTranscript(parent, { ...parent, transcriptPath: null })).toBe("");
        expect(forkTranscript(parent, { ...parent, transcriptPath: "/tmp/x.jsonl" })).toBe("");
        expect(
            forkTranscript(parent, { ...parent, transcriptPath: "/home/node/.claude/projects/a b/$(x).jsonl" })
        ).toBe("");
    });
});

describe("launch script", () => {
    function launch(fork: string, makeFile = true) {
        const root = mkdtempSync(join(tmpdir(), "polaris-fork-"));
        const bin = join(root, "bin");
        mkdirSync(bin);
        const tool = join(bin, "claude");
        writeFileSync(tool, `#!/bin/sh\necho "claude $*"\n`);
        chmodSync(tool, 0o755);
        const posix = (path: string) => path.replace(/\\/g, "/");
        const transcript = fork ? join(root, fork) : "";
        if (transcript && makeFile) writeFileSync(transcript, "{}\n");
        const script = join(root, "launch.sh");
        writeFileSync(script, commands.LAUNCH_SCRIPT);
        const run = () =>
            spawnSync("sh", [posix(script)], {
                cwd: root,
                encoding: "utf8",
                env: {
                    ...process.env,
                    PATH: `${posix(bin)}:${process.env.PATH ?? ""}`,
                    POLARIS_WORKDIR: posix(root),
                    POLARIS_STATE_DIR: posix(root),
                    POLARIS_AS_ROOT: "",
                    POLARIS_AGENT_BINARY: "claude",
                    POLARIS_AGENT_COMMAND: "claude --yolo",
                    POLARIS_AGENT_RESUME: "flag",
                    POLARIS_AGENT_LAUNCHER: "",
                    POLARIS_AGENT_CONFIG: "",
                    // Relative to the cwd: a temp path on Windows has a drive colon.
                    POLARIS_AGENT_FORK: fork
                }
            }).stdout;
        return { run, root };
    }

    it("forks the parent's conversation on the first start only", () => {
        const { run, root } = launch("parent.jsonl");
        const first = run();
        expect(first).toMatch(/claude --yolo --resume parent\.jsonl --fork-session/);
        expect(existsSync(join(root, "forked"))).toBe(true);
        expect(run()).not.toContain("--fork-session");
    });

    it("starts fresh when there is nothing to fork or the transcript is gone", () => {
        expect(launch("").run()).not.toContain("--resume");
        expect(launch("parent.jsonl", false).run()).not.toContain("--resume");
    });
});
