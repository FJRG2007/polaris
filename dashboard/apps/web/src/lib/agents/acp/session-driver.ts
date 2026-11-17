/**
 * One session's agent over the Agent Client Protocol: started, connected and
 * kept, its updates stored as the session's history and its turns reported as
 * the session's state.
 *
 * One connection per session per dashboard process. The agent's pipe outlives
 * the process, but a connection cannot be picked up again half way - the
 * protocol has no way to `initialize` an agent that already was - so the first
 * use after a dashboard restart (or after the agent exited) starts the agent
 * again and reopens its conversation with `session/load` where it can.
 *
 * What lands on the session is Polaris's own sentences: a failure from the
 * agent or the machine is logged here and reported as a failed turn, never
 * shown as the agent wrote it.
 */

import type * as core from "@polaris/core";
import { AcpNormalizer } from "./normalize";
import { NO_DRAFTS, type DraftSink } from "../session-drafts";
import type * as acp from "@agentclientprotocol/sdk";
import { connectAcp, type AcpClient } from "./client";
import type { HistoryRow } from "../transcript-decoders";
import { acpModeFor, type AcpBinding } from "./providers";
import { pipeStream, type PipeIo, type PipeStreamOptions } from "./transport";

/** What a driver needs from the session and the machine. Tests replace it. */
export interface DriverDeps {
    /** The session's agent and checkout, or null when it is gone. */
    session(sessionId: string): Promise<{
        binding: AcpBinding;
        workdir: string;
        vendorSessionId: string | null;
    } | null>;
    /** What `<binary> --version` printed on the session's machine, or null
     *  when it printed nothing a version can be read from. */
    version(sessionId: string, binary: string): Promise<string | null>;
    /** Start (or restart) the agent with this launch line. */
    start(sessionId: string, argv: readonly string[]): Promise<void>;
    pipe(sessionId: string): Promise<PipeIo>;
    storeRows(sessionId: string, rows: readonly HistoryRow[]): Promise<unknown>;
    recordEvents(
        sessionId: string,
        events: readonly { kind: core.AgentSessionEventKind; detail: string; subject: string }[]
    ): Promise<unknown>;
    recordVendorId(sessionId: string, vendorSessionId: string): Promise<void>;
    permission(sessionId: string): (request: acp.RequestPermissionRequest, signal: AbortSignal) => Promise<string | null>;
    touch(sessionId: string): void;
    /** Where the message being written is sent while it grows
     *  (`session-drafts.ts`); none when absent. */
    drafts?(sessionId: string): DraftSink;
    /** Server-side only. */
    log(message: string, error?: unknown): void;
    pipeOptions?: PipeStreamOptions;
    /** How long a freshly started agent may take to appear on its pipe. */
    startWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

/** A refusal written for the person, shown as it stands. */
export class AcpRefusal extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AcpRefusal";
    }
}

/** The sentence for an agent older than its binding's floor. */
export const TOO_OLD = "This agent's version here is too old for Chat. Use Terminal for this session.";

/** The first `major.minor.patch` in a version line, as numbers. Pure. */
export function readVersion(text: string | null): [number, number, number] | null {
    const match = /(\d+)\.(\d+)\.(\d+)/.exec(text ?? "");
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Whether `found` is at least `floor`; an unreadable `found` is not held
 *  against the agent, whose own start then decides. Pure. */
export function meetsFloor(found: string | null, floor: string): boolean {
    const have = readVersion(found);
    const need = readVersion(floor);
    if (!have || !need) return true;
    for (let i = 0; i < 3; i++) {
        if (have[i]! !== need[i]!) return have[i]! > need[i]!;
    }
    return true;
}

const sleepFor = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** A just-launched agent's pipe answers "not running" until its script has
 *  written the new generation. Shared with the Codex app-server driver. */
export async function waitForAgent(
    io: PipeIo,
    options: { startWaitMs?: number; sleep?: (ms: number) => Promise<void> }
): Promise<void> {
    const sleep = options.sleep ?? sleepFor;
    const deadline = Date.now() + (options.startWaitMs ?? 30_000);
    for (;;) {
        const read = await io.read(0).catch(() => null);
        if (read && read.exitCode === null) return;
        if (read && read.exitCode !== null) throw new AcpRefusal("The agent exited as soon as it started.");
        if (Date.now() >= deadline) throw new AcpRefusal("The agent did not start in time.");
        await sleep(250);
    }
}

interface Connection {
    client: AcpClient;
    acpSessionId: string;
    normalizer: AcpNormalizer;
    modes: readonly acp.SessionMode[];
    /** Updates are dropped while a loaded conversation replays: they are
     *  already the session's history. */
    replaying: boolean;
}

export class AcpSessionDriver {
    private connection: Connection | null = null;
    private opening: Promise<Connection> | null = null;
    private turn: Promise<void> | null = null;
    /** Stored rows, in order, so a turn's closing rows land after its last update. */
    private stored: Promise<unknown> = Promise.resolve();
    private closedByUs = false;
    private readonly draft: DraftSink;

    constructor(
        readonly sessionId: string,
        private readonly deps: DriverDeps
    ) {
        this.draft = deps.drafts?.(sessionId) ?? NO_DRAFTS;
    }

    /** Whether a turn is running. */
    get busy(): boolean {
        return this.turn !== null;
    }

    /** Send a message. Returns once the agent has it; the turn runs on. */
    async prompt(text: string): Promise<void> {
        if (this.turn) throw new AcpRefusal("The agent is still on the last message. Stop it or wait for it to finish.");
        const connection = await this.connect();
        await this.deps.recordEvents(this.sessionId, [{ kind: "prompt", detail: "", subject: "" }]);
        const run = connection.client.prompt(connection.acpSessionId, text);
        this.turn = run.then(
            (response) => this.endTurn(connection, response.stopReason, null),
            (error: unknown) => this.endTurn(connection, undefined, error)
        );
    }

    /** Stop the running turn, if there is one. */
    async cancel(): Promise<void> {
        const connection = this.connection;
        if (!connection || !this.turn) return;
        await connection.client.cancel(connection.acpSessionId);
    }

    /** Put the agent in the mode a Polaris permission mode stands for. */
    async setMode(mode: core.SessionPermissionMode): Promise<void> {
        const connection = await this.connect();
        const session = await this.deps.session(this.sessionId);
        const id = session ? acpModeFor(session.binding, mode, connection.modes) : null;
        if (!id) throw new AcpRefusal("This agent has no such mode in Chat.");
        await connection.client.setMode(connection.acpSessionId, id);
    }

    /** End the connection. The agent's window is the caller's to take down. */
    close(): void {
        this.closedByUs = true;
        this.draft.end();
        this.connection?.client.close();
        this.connection = null;
    }

    /** Resolves when the running turn (if any) has been recorded. Tests. */
    async settled(): Promise<void> {
        await this.turn;
        await this.stored;
    }

    private connect(): Promise<Connection> {
        if (this.connection) return Promise.resolve(this.connection);
        if (!this.opening) {
            this.closedByUs = false;
            this.opening = this.open().finally(() => {
                this.opening = null;
            });
        }
        return this.opening;
    }

    private async open(): Promise<Connection> {
        const session = await this.deps.session(this.sessionId);
        if (!session) throw new AcpRefusal("That session no longer exists.");
        // An older release has no ACP mode and exits at once, which would read
        // as "exited as soon as it started" instead of the reason.
        if (session.binding.minVersion) {
            const found = await this.deps.version(this.sessionId, session.binding.argv[0]!).catch(() => null);
            if (!meetsFloor(found, session.binding.minVersion)) throw new AcpRefusal(TOO_OLD);
        }
        await this.deps.start(this.sessionId, session.binding.argv);
        const io = await this.deps.pipe(this.sessionId);
        await waitForAgent(io, this.deps);

        let connection: Connection | null = null;
        const client = connectAcp(pipeStream(io, this.deps.pipeOptions), {
            onUpdate: (notification) => {
                if (!connection || connection.replaying) return;
                if (notification.sessionId !== connection.acpSessionId) return;
                const rows = connection.normalizer.push(notification.update);
                if (rows.length > 0) this.store(rows);
                const draft = connection.normalizer.draft();
                if (draft) this.draft.set(draft.id, draft.text);
                else this.draft.end();
                if (notification.update.sessionUpdate === "current_mode_update") return;
                // A chunk that completed nothing changed nothing stored: the
                // draft carries it, and a page need not read the session again.
                if (notification.update.sessionUpdate === "agent_message_chunk" && rows.length === 0) return;
                this.deps.touch(this.sessionId);
            },
            onPermission: async (request, signal) => {
                const ask = this.deps.permission(this.sessionId);
                const tool = (request.toolCall.title?.trim() || request.toolCall.kind || "tool").slice(0, 80);
                await this.deps.recordEvents(this.sessionId, [{ kind: "permission", detail: tool, subject: tool }]);
                const chosen = await ask(request, signal);
                await this.deps.recordEvents(this.sessionId, [{ kind: "tool.start", detail: "", subject: tool }]);
                return chosen;
            },
            onHandlerError: (what, error) => this.deps.log(`${this.sessionId}: the ${what} handler failed`, error)
        });

        try {
            const init = await client.initialize();
            let acpSessionId: string | null = null;
            let modes: readonly acp.SessionMode[] = [];
            // Set before the load, so the replay it sends is held back.
            connection = {
                client,
                acpSessionId: "",
                normalizer: new AcpNormalizer(this.sessionId),
                modes: [],
                replaying: true
            };
            if (init.agentCapabilities?.loadSession && session.vendorSessionId) {
                connection.acpSessionId = session.vendorSessionId;
                try {
                    const loaded = await client.loadSession(session.vendorSessionId, session.workdir);
                    acpSessionId = session.vendorSessionId;
                    modes = loaded.modes?.availableModes ?? [];
                } catch (error) {
                    this.deps.log(`${this.sessionId}: the agent would not reopen its conversation, starting a new one`, error);
                }
            }
            if (!acpSessionId) {
                const opened = await client.newSession(session.workdir);
                acpSessionId = opened.sessionId;
                modes = opened.modes?.availableModes ?? [];
            }
            // Ids of rows from this connection never meet those of the last
            // one: a fresh normaliser numbers its unnamed messages from one.
            connection.normalizer = new AcpNormalizer(`${acpSessionId}:${Date.now().toString(36)}`);
            connection.acpSessionId = acpSessionId;
            connection.modes = modes;
            connection.replaying = false;
            await this.deps.recordVendorId(this.sessionId, acpSessionId);
        } catch (error) {
            client.close(error);
            throw error;
        }

        const ready = connection;
        this.connection = ready;
        void client.closed.then(() => {
            if (this.connection === ready) this.connection = null;
            if (!this.closedByUs) this.deps.log(`${this.sessionId}: the connection to the agent ended`);
        });
        return ready;
    }

    private store(rows: readonly HistoryRow[]): void {
        this.stored = this.stored
            .then(() => this.deps.storeRows(this.sessionId, rows))
            .catch((error: unknown) => this.deps.log(`${this.sessionId}: history rows were not stored`, error));
    }

    private async endTurn(connection: Connection, stopReason: acp.StopReason | undefined, error: unknown): Promise<void> {
        // The response can overtake the last updates' handlers by a microtask;
        // a macrotask lets every one of them run first.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const rows = connection.normalizer.finish(stopReason);
        this.draft.end();
        if (rows.length > 0) this.store(rows);
        await this.stored;
        this.turn = null;
        if (error !== null) {
            this.deps.log(`${this.sessionId}: the turn failed`, error);
            await this.deps
                .recordEvents(this.sessionId, [{ kind: "turn.failed", detail: "The agent stopped before it answered.", subject: "" }])
                .catch(() => undefined);
            return;
        }
        await this.deps
            .recordEvents(this.sessionId, [
                stopReason === "refusal"
                    ? { kind: "turn.failed", detail: "The agent declined to carry on.", subject: "" }
                    : { kind: "turn.end", detail: "", subject: "" }
            ])
            .catch(() => undefined);
    }
}
