/**
 * Resuming a session whose agent exited: what a hook may store about its
 * conversation, the line typed back into the shell for each tool, and the
 * action behind the button - only for whoever may steer the session, and only
 * once the terminal says the agent is gone.
 */

import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";

const state = vi.hoisted(() => ({
    allowed: true,
    session: null as Record<string, unknown> | null,
    vendorId: null as string | null,
    exited: true,
    resumeError: null as Error | null,
    resumed: [] as { sessionId: string; vendorId: string }[]
}));

vi.mock("@polaris/db", () => ({
    prisma: {
        agentSession: { findUnique: vi.fn(async () => null), update: vi.fn(async () => ({})) },
        agentSessionMessage: { findFirst: vi.fn(async () => null) }
    }
}));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/github-service", () => ({}));
vi.mock("@/lib/github-access", () => ({
    credentialFor: vi.fn(),
    githubCredentialsForUser: vi.fn(async () => [])
}));
vi.mock("@/lib/agents/session-runtime", () => ({
    runInSession: vi.fn(),
    agentHasExited: vi.fn(async () => state.exited),
    resumeAgent: vi.fn(async (sessionId: string, vendorId: string) => {
        if (state.resumeError) throw state.resumeError;
        state.resumed.push({ sessionId, vendorId });
    })
}));
vi.mock("@/lib/agents/session-work", () => ({ saveSessionWork: vi.fn() }));
vi.mock("@/lib/tasks/access", () => ({}));
vi.mock("@/lib/tasks/task-detail-service", () => ({ addComment: vi.fn() }));
vi.mock("@/lib/agents/agent-readiness", () => ({
    agentChoicesFor: vi.fn(),
    agentOptionsFor: vi.fn()
}));
vi.mock("@/lib/agents/session-capacity", () => ({
    capacityRefusal: vi.fn(),
    sessionCapacity: vi.fn(),
    sharedWorkspaceAllowed: vi.fn(),
    workspaceHolders: vi.fn(),
    workspaceRefusal: vi.fn()
}));
vi.mock("@/lib/notifications/notice-words", () => ({ wordsFor: vi.fn() }));
vi.mock("@/lib/agents/words", () => ({
    agentText: (_t: unknown, text: string) => text,
    knownAgentText: vi.fn()
}));
vi.mock("@/lib/domain-service", () => ({
    appBaseUrl: vi.fn(async () => "https://polaris.example.test/")
}));
vi.mock("@/lib/i18n/request", () => ({ getTranslations: vi.fn(async () => (key: string) => key) }));
vi.mock("@/lib/session", () => ({
    requirePermission: vi.fn(async (permission: string) => {
        if (permission === "agents.manage" && !state.allowed) throw new Error("forbidden");
        return { id: "user-1" };
    })
}));
vi.mock("@/lib/agents/session-service", async () => {
    const actual = await vi.importActual<typeof import("@/lib/agents/session-service")>(
        "@/lib/agents/session-service"
    );
    return {
        SessionRefusal: actual.SessionRefusal,
        readableFailure: actual.readableFailure,
        getSession: vi.fn(async () => state.session),
        sessionVendorId: vi.fn(async () => state.vendorId)
    };
});

import * as core from "@polaris/core";
import * as commands from "@/lib/agents/session-commands";
import { hookConversation } from "@/lib/agents/session-hooks";
import { SessionRefusal } from "@/lib/agents/session-service";
import {
    resumeSessionAction,
    sessionResumableAction
} from "@/app/(app)/apps/agents/sessions/actions";

const SESSION_ID = "0190a0f0-0000-7000-8000-000000000001";
const VENDOR_ID = "5f2c9a1e-7d3b-4c2a-9e1f-0a1b2c3d4e5f";

describe("what a hook may store about its conversation", () => {
    it("keeps an id and an absolute transcript path", () => {
        expect(
            hookConversation({
                session_id: VENDOR_ID,
                transcript_path: "/home/agent/.claude/projects/app/x.jsonl"
            })
        ).toEqual({
            vendorSessionId: VENDOR_ID,
            transcriptPath: "/home/agent/.claude/projects/app/x.jsonl"
        });
    });

    it("drops an id that is not letters, digits and dashes", () => {
        for (const bad of ["abc;touch pwned", "$(id)", "a b", "", "x".repeat(129), 42, null]) {
            expect(hookConversation({ session_id: bad }).vendorSessionId).toBeNull();
        }
    });

    it("drops a transcript path that is relative, climbs, or carries a control character", () => {
        for (const bad of [
            "relative/x.jsonl",
            "/home/../etc/passwd",
            "/tmp/x\n.jsonl",
            `/${"a".repeat(1100)}`,
            7
        ]) {
            expect(hookConversation({ transcript_path: bad }).transcriptPath).toBeNull();
        }
    });

    it("reads a payload that is not an object as saying nothing", () => {
        for (const payload of [null, undefined, "text", 3]) {
            expect(hookConversation(payload)).toEqual({
                vendorSessionId: null,
                transcriptPath: null
            });
        }
    });
});

describe("the resume line", () => {
    it("types the launch script with the id, quoted, without a newline", () => {
        const line = commands.resumeCommand(VENDOR_ID);
        expect(line).toContain("tmux send-keys");
        expect(line).toContain(" -l ");
        expect(line).toContain(`launch.sh" ${VENDOR_ID}`);
        expect(line).not.toContain("\n");
    });

    it("refuses an id that is not one", () => {
        expect(() => commands.resumeCommand("abc;touch pwned")).toThrow();
        expect(() => commands.resumeCommand("")).toThrow();
    });

    it("asks the terminal only after the boot is over", () => {
        const check = commands.agentExitedCommand();
        expect(check.startsWith(`test -f ${commands.AGENT_READY_FLAG} && `)).toBe(true);
        expect(check).toContain("icanon");
    });

    /** The launch script, run in a real shell with stand-in tools that echo themselves. */
    function launch(cli: "claude" | "codex", id: string) {
        const root = mkdtempSync(join(tmpdir(), "polaris-resume-"));
        const bin = join(root, "bin");
        mkdirSync(bin);
        const tool = join(bin, cli);
        writeFileSync(tool, `#!/bin/sh\necho "${cli} $*"\n`);
        chmodSync(tool, 0o755);
        const posix = (path: string) => path.replace(/\\/g, "/");
        return spawnSync("sh", ["-c", `${commands.LAUNCH_SCRIPT}`, "launch", id], {
            encoding: "utf8",
            env: {
                ...process.env,
                PATH: `${posix(bin)}:${process.env.PATH ?? ""}`,
                POLARIS_WORKDIR: posix(root),
                POLARIS_STATE_DIR: posix(root),
                POLARIS_AS_ROOT: "",
                POLARIS_AGENT_BINARY: cli,
                POLARIS_AGENT_COMMAND: `${cli} --yolo`,
                POLARIS_AGENT_RESUME: core.agentResumeStyle(cli),
                POLARIS_AGENT_LAUNCHER: "",
                POLARIS_AGENT_CONFIG: ""
            }
        });
    }

    it("reopens Claude Code with --resume", () => {
        expect(core.agentResumeStyle("claude")).toBe("flag");
        expect(launch("claude", VENDOR_ID).stdout).toContain(`claude --yolo --resume ${VENDOR_ID}`);
    });

    it("reopens Codex with its resume subcommand before the flags", () => {
        expect(core.agentResumeStyle("codex")).toBe("subcommand");
        expect(launch("codex", VENDOR_ID).stdout).toContain(`codex resume ${VENDOR_ID} --yolo`);
    });

    it("offers no resume for a tool nothing has been sourced about", () => {
        expect(core.agentResumeStyle("gemini")).toBe("");
    });
});

describe("the Resume action", () => {
    beforeEach(() => {
        state.allowed = true;
        state.session = { id: SESSION_ID, cli: "claude", state: "idle" };
        state.vendorId = VENDOR_ID;
        state.exited = true;
        state.resumeError = null;
        state.resumed = [];
    });

    it("types the resume for somebody who may steer an exited agent", async () => {
        expect(await resumeSessionAction({ sessionId: SESSION_ID })).toEqual({});
        expect(state.resumed).toEqual([{ sessionId: SESSION_ID, vendorId: VENDOR_ID }]);
    });

    it("refuses somebody who may not steer agents", async () => {
        state.allowed = false;
        await expect(resumeSessionAction({ sessionId: SESSION_ID })).rejects.toThrow("forbidden");
        await expect(sessionResumableAction(SESSION_ID)).rejects.toThrow("forbidden");
        expect(state.resumed).toEqual([]);
    });

    it("refuses a session the reader cannot see", async () => {
        state.session = null;
        expect(await resumeSessionAction({ sessionId: SESSION_ID })).toEqual({
            error: "sessions.errors.gone"
        });
        expect(await sessionResumableAction(SESSION_ID)).toEqual({ resumable: false });
    });

    it("types nothing into an agent that is still running", async () => {
        state.exited = false;
        expect(await resumeSessionAction({ sessionId: SESSION_ID })).toEqual({
            error: "sessions.errors.stillRunning"
        });
        expect(await sessionResumableAction(SESSION_ID)).toEqual({ resumable: false });
        expect(state.resumed).toEqual([]);
    });

    it("offers nothing without a conversation, or for a tool that cannot resume", async () => {
        state.vendorId = null;
        expect(await resumeSessionAction({ sessionId: SESSION_ID })).toEqual({
            error: "sessions.errors.notResumable"
        });
        state.vendorId = VENDOR_ID;
        state.session = { id: SESSION_ID, cli: "gemini", state: "idle" };
        expect(await sessionResumableAction(SESSION_ID)).toEqual({ resumable: false });
        expect(state.resumed).toEqual([]);
    });

    it("refuses a session that is over", async () => {
        state.session = { id: SESSION_ID, cli: "claude", state: "stopped" };
        expect(core.isSessionOver("stopped")).toBe(true);
        expect(await resumeSessionAction({ sessionId: SESSION_ID })).toEqual({
            error: "sessions.errors.ended"
        });
        expect(await sessionResumableAction(SESSION_ID)).toEqual({ resumable: false });
    });

    it("says it is resumable only when every check passes", async () => {
        expect(await sessionResumableAction(SESSION_ID)).toEqual({ resumable: true });
        expect(await sessionResumableAction("not-an-id")).toEqual({ resumable: false });
    });

    it("refuses input that is not a session id", async () => {
        for (const input of [{ sessionId: "nope" }, {}, null, { sessionId: SESSION_ID, x: 1 }]) {
            expect(await resumeSessionAction(input)).toEqual({
                error: "session.changes.errors.invalid"
            });
        }
    });

    it("shows a refusal as written and anything else as the generic sentence", async () => {
        state.resumeError = new SessionRefusal("The machine is asleep.");
        expect(await resumeSessionAction({ sessionId: SESSION_ID })).toEqual({
            error: "The machine is asleep."
        });
        state.resumeError = new Error("ssh: connect to 10.0.0.4 port 22 refused");
        const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
        const result = await resumeSessionAction({ sessionId: SESSION_ID });
        spy.mockRestore();
        expect(result.error).not.toContain("10.0.0.4");
        expect(result.error).toBe(
            "Polaris could not start this session. Nothing was left running."
        );
    });
});
