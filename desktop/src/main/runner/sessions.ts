/**
 * The sessions a runner holds: a `session.start` prepares the toolchain,
 * puts the work in place, starts the agent CLI in a terminal of its own, and
 * from then on the server's frames drive that terminal.
 *
 * The terminal is a real pseudo-terminal (`node-pty`, ConPTY on Windows, the
 * library VS Code's terminal runs on), so a TUI agent draws exactly as it does
 * in the person's own terminal. tmux is not needed: the runner process is the
 * thing that outlives a viewer, and a viewer that attaches gets the last
 * screenful replayed.
 *
 * Pure apart from what is handed in (`SessionDeps`), so it is tested with a
 * fake terminal, fake git and a fake toolchain.
 */

import * as launch from "./launch";
import { randomUUID } from "node:crypto";
import type { Checkout } from "./workspace";
import type { RunnerFrame, ServerFrame } from "./connection";
import { RUNNER_LIMITS } from "../../../../dashboard/packages/core/src/runner-protocol";

export interface Terminal {
    onData(listener: (data: string) => void): void;
    onExit(listener: (exit: { exitCode: number; }) => void): void;
    write(data: string): void;
    resize(cols: number, rows: number): void;
    kill(): void;
}

export interface SpawnTerminal {
    (file: string, args: string[], options: { cwd: string; env: Record<string, string>; cols: number; rows: number; }): Terminal;
}

export type ToolchainProgressFrame = Omit<RunnerFrame & { type: "toolchain.progress"; }, "type" | "requestId" | "sessionId">;
export type PrepareOutcome = { ok: true; env: Record<string, string>; } | { ok: false; tool: string; code: string; };

export interface SessionDeps {
    /** `<userData>/runner`: repos, sessions and their state live under it. */
    readonly root: string;
    readonly platform: string;
    /** Folders the person picked that a `path` session may work in. */
    readonly allowedFolders: () => readonly string[];
    readonly send: (frame: RunnerFrame) => boolean;
    readonly spawnTerminal: SpawnTerminal;
    /** Prepare the toolchain for these agents, reporting each change. */
    readonly prepare: (agents: string[], onProgress: (progress: ToolchainProgressFrame) => void) => Promise<PrepareOutcome>;
    /** Run git with an argument array; resolves with its exit code. */
    readonly git: (args: string[], options: { cwd: string; env: Record<string, string>; }) => Promise<number>;
    readonly exists: (file: string) => boolean;
    readonly mkdir: (dir: string) => Promise<void>;
    readonly writeFile: (file: string, text: string) => Promise<void>;
    readonly maxSessions: number;
    readonly setTimer?: (run: () => void, ms: number) => unknown;
    readonly log?: (message: string) => void;
}

/** Output kept for a viewer that attaches later: about one screen redraw. */
const REPLAY_BYTES = 64 * 1024;
/** Output is gathered this long before it is sent, so a burst is one frame. */
const FLUSH_MS = 16;
/** Quiet after the agent's first output before a queued prompt is typed. */
const SETTLE_MS = 1500;

interface Held {
    readonly id: string;
    readonly cli: string;
    terminal: Terminal | null;
    seq: number;
    pending: string;
    flushing: boolean;
    replay: string;
    /** Prompts that arrived before the agent was ready to read them. */
    queue: string[];
    ready: boolean;
    settle: unknown;
    stopped: boolean;
    /** The checkout and the toolchain's environment, once in place. */
    checkout: Checkout | null;
}

export class SessionHost {
    readonly #held = new Map<string, Held>();
    readonly #setTimer: (run: () => void, ms: number) => unknown;

    constructor(private readonly deps: SessionDeps) {
        this.#setTimer = deps.setTimer ?? ((run, ms) => setTimeout(run, ms));
    }

    ids(): string[] {
        return [...this.#held.keys()];
    }

    /** Where a held session works, for `workspace.read`. Null for a session
     *  this computer does not hold or that is not in place yet. */
    checkout(sessionId: string): Checkout | null {
        return this.#held.get(sessionId)?.checkout ?? null;
    }

    /** One server frame about a session. Answers false for a frame that is not
     *  a session's, so the caller can hand it on. */
    handle(frame: ServerFrame): boolean {
        switch (frame.type) {
            case "session.start":
                void this.#start(frame);
                return true;
            case "prompt":
                this.#prompt(frame.sessionId, frame.text);
                return true;
            case "interrupt": {
                const held = this.#held.get(frame.sessionId);
                held?.terminal?.write(launch.interruptKey(held.cli));
                return true;
            }
            case "session.stop":
                this.stop(frame.sessionId, "stopped");
                return true;
            case "session.settings": {
                const held = this.#held.get(frame.sessionId);
                // Claude Code switches model in place; the rest of a running
                // session's settings take effect on its next start.
                if (held?.cli === "claude" && frame.model && /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,199}$/.test(frame.model))
                    this.#prompt(frame.sessionId, `/model ${frame.model}`);
                return true;
            }
            case "terminal.attach": {
                const held = this.#held.get(frame.sessionId);
                if (!held) return true;
                held.terminal?.resize(frame.cols, frame.rows);
                if (held.replay) this.#emit(held, held.replay);
                return true;
            }
            case "terminal.detach":
                return true;
            case "terminal.input": {
                const held = this.#held.get(frame.sessionId);
                held?.terminal?.write(Buffer.from(frame.data, "base64").toString("utf8"));
                return true;
            }
            case "terminal.resize":
                this.#held.get(frame.sessionId)?.terminal?.resize(frame.cols, frame.rows);
                return true;
            case "permission.decision":
                // Hooks post to the session's report URL over HTTPS and read
                // their answer there; nothing is relayed through this socket.
                return true;
            default:
                return false;
        }
    }

    /** End a session here and tell the server why. */
    stop(sessionId: string, reason: "stopped" | "failed", detail?: string): void {
        const held = this.#held.get(sessionId);
        if (!held || held.stopped) return;
        held.stopped = true;
        this.#held.delete(sessionId);
        try {
            held.terminal?.kill();
        } catch {
            // Already gone.
        }
        this.deps.send({ type: "session.ended", sessionId, reason, ...(detail ? { detail } : {}) });
    }

    /** Every session ends, e.g. when the app quits or the computer is unpaired. */
    stopAll(): void {
        for (const id of this.ids()) this.stop(id, "stopped");
    }

    async #start(start: launch.SessionStart): Promise<void> {
        const { deps } = this;
        if (this.#held.has(start.sessionId)) return;
        if (this.#held.size >= deps.maxSessions) {
            deps.send({ type: "session.ended", sessionId: start.sessionId, reason: "failed", detail: "This computer is running as many sessions as it allows." });
            return;
        }
        const held: Held = {
            id: start.sessionId,
            cli: start.cli,
            terminal: null,
            seq: 0,
            pending: "",
            flushing: false,
            replay: "",
            queue: [],
            ready: false,
            settle: null,
            stopped: false,
            checkout: null
        };
        this.#held.set(start.sessionId, held);
        const fail = (detail: string) => this.stop(start.sessionId, "failed", detail);
        try {
            const requestId = randomUUID();
            const agents = start.cli === launch.CUSTOM_CLI ? [] : [start.cli];
            const prepared = await deps.prepare(agents, (progress) => {
                deps.send({ type: "toolchain.progress", requestId, sessionId: start.sessionId, ...progress });
            });
            if (held.stopped) return;
            // The progress frame already carried the failure word the screen
            // translates; this ends the session after it.
            if (!prepared.ok) return fail(`toolchain:${prepared.tool}:${prepared.code}`);

            const plan = launch.planWorkspace(start, deps.root, deps.allowedFolders(), deps.exists);
            if (!plan.ok) return fail(`workspace:${plan.reason}`);
            for (const folder of plan.workspace.folders) await deps.mkdir(folder);
            for (const step of plan.workspace.steps) {
                const code = await deps.git(step.args, { cwd: step.cwd, env: { ...prepared.env, GIT_TERMINAL_PROMPT: "0" } });
                if (held.stopped) return;
                if (code !== 0) return fail(`git:${step.args[0]}`);
            }

            held.checkout = { workdir: plan.workspace.workdir, env: prepared.env };
            const stateDir = `${deps.root}/state/${start.sessionId}`;
            await deps.mkdir(stateDir);
            const settingsFile = `${stateDir}/claude-settings.json`;
            if (start.cli === "claude") await deps.writeFile(settingsFile, JSON.stringify(launch.claudeRunnerSettings()));
            const cli = launch.cliLaunch(start, prepared.env, deps.platform, deps.exists, settingsFile);
            if (!cli.ok) return fail(`cli:${cli.reason}`);
            if (held.stopped) return;

            const terminal = deps.spawnTerminal(cli.command, cli.args, { cwd: plan.workspace.workdir, env: cli.env, cols: start.cols, rows: start.rows });
            held.terminal = terminal;
            terminal.onData((data) => this.#output(held, data));
            terminal.onExit(({ exitCode }) => {
                if (held.stopped) return;
                this.#flush(held);
                held.stopped = true;
                this.#held.delete(held.id);
                deps.send({ type: "session.ended", sessionId: held.id, reason: "exited", exitCode });
            });
            deps.send({
                type: "session.started",
                sessionId: start.sessionId,
                workdir: plan.workspace.workdir.slice(0, 1000),
                ...(start.repository.kind === "clone" ? { branch: start.branch } : {})
            });
            if (start.prompt) this.#prompt(start.sessionId, start.prompt);
        } catch (error) {
            deps.log?.(`runner: session ${start.sessionId} failed to start: ${String(error)}`);
            fail("start");
        }
    }

    #prompt(sessionId: string, text: string): void {
        const held = this.#held.get(sessionId);
        if (!held) return;
        if (!held.ready || !held.terminal) held.queue.push(text);
        else held.terminal.write(launch.promptKeys(text));
    }

    #output(held: Held, data: string): void {
        held.replay = (held.replay + data).slice(-REPLAY_BYTES);
        held.pending += data;
        if (!held.ready) {
            // Ready once the agent has drawn and then been quiet a moment.
            if (held.settle === null) {
                const arm = () =>
                    this.#setTimer(() => {
                        held.settle = null;
                        if (held.stopped) return;
                        held.ready = true;
                        const queued = held.queue.splice(0);
                        for (const text of queued) held.terminal?.write(launch.promptKeys(text));
                    }, SETTLE_MS);
                held.settle = arm();
            }
        }
        if (!held.flushing) {
            held.flushing = true;
            this.#setTimer(() => this.#flush(held), FLUSH_MS);
        }
    }

    #flush(held: Held): void {
        held.flushing = false;
        const data = held.pending;
        held.pending = "";
        if (data) this.#emit(held, data);
    }

    /** Send terminal output in chunks the protocol accepts. */
    #emit(held: Held, data: string): void {
        const bytes = Buffer.from(data, "utf8");
        for (let offset = 0; offset < bytes.length; offset += RUNNER_LIMITS.terminalChunkBytes) {
            const chunk = bytes.subarray(offset, offset + RUNNER_LIMITS.terminalChunkBytes);
            this.deps.send({ type: "terminal.output", sessionId: held.id, seq: held.seq++, data: chunk.toString("base64") });
        }
    }
}
