/**
 * One Codex session's agent over Codex's own app-server protocol, instead of
 * its terminal: started, connected and kept, its items stored as the
 * session's history, its turns reported as the session's state and its
 * approvals put to the person through the session's own permission prompts.
 * The Codex counterpart of `acp/session-driver.ts`, on the same pipe.
 *
 * The order of a conversation (learn.chatgpt.com/docs/app-server):
 * `initialize`, then the `initialized` notification; `thread/resume` on the
 * stored thread id where there is one, else `thread/start`; one `turn/start`
 * per message, the turn running until `turn/completed`; `turn/interrupt` to
 * stop it. An approval is a server request that holds the turn until it is
 * answered, so every request is answered - a decision for the two approvals
 * Polaris models, an error for anything else.
 *
 * A Codex with no app-server is not an error to show: the session goes back
 * to its terminal (`CodexAppServerMissing`, handled by `session-runtime.ts`),
 * which is how it ran before Chat existed.
 */

import type * as core from "@polaris/core";
import { CodexNormalizer } from "./normalize";
import type { HistoryRow } from "../transcript-decoders";
import type { PermissionStatus } from "../session-permissions";
import { AcpRefusal, waitForAgent } from "../acp/session-driver";
import { CodexRpc, CodexRpcError, METHOD_NOT_FOUND } from "./rpc";
import { pipeByteStreams, type PipeIo, type PipeStreamOptions } from "../acp/transport";
import * as protocol from "./protocol";

/** The installed Codex has no app-server: the session belongs in its terminal. */
export class CodexAppServerMissing extends Error {
    constructor() {
        super("This Codex has no app-server.");
        this.name = "CodexAppServerMissing";
    }
}

/** What a driver needs from the session and the machine. Tests replace it. */
export interface CodexDriverDeps {
    /** The session's checkout, stored thread and permission mode, or null
     *  when it is gone. */
    session(sessionId: string): Promise<{
        workdir: string;
        vendorSessionId: string | null;
        mode: core.SessionPermissionMode | null;
    } | null>;
    /** What `codex app-server --help` printed on the session's machine, or
     *  null when it could not be run. */
    help(sessionId: string): Promise<string | null>;
    /** Start (or restart) the agent with this launch line. */
    start(sessionId: string, argv: readonly string[]): Promise<void>;
    pipe(sessionId: string): Promise<PipeIo>;
    storeRows(sessionId: string, rows: readonly HistoryRow[]): Promise<unknown>;
    recordEvents(
        sessionId: string,
        events: readonly { kind: core.AgentSessionEventKind; detail: string; subject: string }[]
    ): Promise<unknown>;
    recordVendorId(sessionId: string, vendorSessionId: string): Promise<void>;
    /** Put a request to the person; resolves to their answer. */
    ask(sessionId: string, prompt: { tool: string; detail: string }, signal: AbortSignal): Promise<PermissionStatus>;
    touch(sessionId: string): void;
    /** Server-side only. */
    log(message: string, error?: unknown): void;
    pipeOptions?: PipeStreamOptions;
    startWaitMs?: number;
    sleep?: (ms: number) => Promise<void>;
}

interface Connection {
    rpc: CodexRpc;
    threadId: string;
    normalizer: CodexNormalizer;
}

interface Turn {
    /** Null until `turn/start` answers. */
    id: string | null;
    done: Promise<void>;
    end: (status: string, error: string | null) => void;
}

/** The mode a session without one stored runs in: the terminal's own. */
const DEFAULT_MODE: core.SessionPermissionMode = "full";

export class CodexSessionDriver {
    private connection: Connection | null = null;
    private opening: Promise<Connection> | null = null;
    private turn: Turn | null = null;
    /** Turns that completed before `turn/start` answered with their id. */
    private readonly early = new Map<string, { status: string; error: string | null }>();
    private stored: Promise<unknown> = Promise.resolve();
    private closedByUs = false;
    /** A mode picked mid-session, for the next turn. */
    private mode: core.SessionPermissionMode | null = null;

    constructor(
        readonly sessionId: string,
        private readonly deps: CodexDriverDeps
    ) {}

    get busy(): boolean {
        return this.turn !== null;
    }

    /** Send a message. Returns once Codex has started the turn; it runs on. */
    async prompt(text: string): Promise<void> {
        if (this.turn) throw new AcpRefusal("The agent is still on the last message. Stop it or wait for it to finish.");
        const connection = await this.connect();
        const session = await this.deps.session(this.sessionId);
        const settings = protocol.MODE_SETTINGS[this.mode ?? session?.mode ?? DEFAULT_MODE];
        await this.deps.recordEvents(this.sessionId, [{ kind: "prompt", detail: "", subject: "" }]);

        let end: Turn["end"] = () => undefined;
        const done = new Promise<{ status: string; error: string | null }>((resolve) => {
            end = (status, error) => resolve({ status, error });
        });
        const turn: Turn = { id: null, done: Promise.resolve(), end };
        this.turn = turn;
        turn.done = done.then((outcome) => this.endTurn(connection, turn, outcome.status, outcome.error));

        let started: unknown;
        try {
            started = await connection.rpc.request("turn/start", {
                threadId: connection.threadId,
                input: [{ type: "text", text }],
                approvalPolicy: settings.approvalPolicy,
                sandboxPolicy: settings.sandboxPolicy
            });
        } catch (error) {
            this.deps.log(`${this.sessionId}: the turn did not start`, error);
            turn.end("failed", null);
            await turn.done;
            return;
        }
        const parsed = protocol.turnResultSchema.safeParse(started);
        if (!parsed.success) {
            turn.end("failed", null);
            return;
        }
        turn.id = parsed.data.turn.id;
        const early = this.early.get(turn.id);
        if (early) {
            this.early.delete(turn.id);
            turn.end(early.status, early.error);
        }
    }

    /** Stop the running turn, if there is one. */
    async cancel(): Promise<void> {
        const connection = this.connection;
        const id = this.turn?.id;
        if (!connection || !id) return;
        await connection.rpc.request("turn/interrupt", { threadId: connection.threadId, turnId: id });
    }

    /** The mode for the next turn: Codex takes a turn's approval policy and
     *  sandbox as the thread's defaults from then on. */
    async setMode(mode: core.SessionPermissionMode): Promise<void> {
        this.mode = mode;
    }

    close(): void {
        this.closedByUs = true;
        this.connection?.rpc.close();
        this.connection = null;
    }

    /** Resolves when the running turn (if any) has been recorded. Tests. */
    async settled(): Promise<void> {
        await this.turn?.done;
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
        const help = await this.deps.help(this.sessionId).catch(() => null);
        if (!protocol.hasAppServer(help)) throw new CodexAppServerMissing();
        await this.deps.start(this.sessionId, protocol.CODEX_APP_SERVER_ARGV);
        const io = await this.deps.pipe(this.sessionId);
        await waitForAgent(io, this.deps);

        let connection: Connection | null = null;
        const rpc = new CodexRpc(pipeByteStreams(io, this.deps.pipeOptions), {
            onNotification: (method, params) => {
                if (connection) this.notified(connection, method, params);
            },
            onRequest: (method, params, signal) => this.requested(method, params, signal),
            onDropped: (what) => this.deps.log(`${this.sessionId}: dropped a malformed ${what} frame`),
            onHandlerError: (what, error) => this.deps.log(`${this.sessionId}: the ${what} handler failed`, error)
        });

        try {
            await rpc.request("initialize", { clientInfo: protocol.CLIENT_INFO });
            await rpc.notify("initialized", {});
            const settings = protocol.MODE_SETTINGS[this.mode ?? session.mode ?? DEFAULT_MODE];
            let threadId: string | null = null;
            if (session.vendorSessionId) {
                try {
                    const resumed = protocol.threadResultSchema.parse(
                        await rpc.request("thread/resume", { threadId: session.vendorSessionId, excludeTurns: true })
                    );
                    threadId = resumed.thread.id;
                } catch (error) {
                    this.deps.log(`${this.sessionId}: Codex would not reopen its thread, starting a new one`, error);
                }
            }
            if (!threadId) {
                const opened = protocol.threadResultSchema.parse(
                    await rpc.request("thread/start", {
                        cwd: session.workdir,
                        approvalPolicy: settings.approvalPolicy,
                        sandbox: settings.sandbox
                    })
                );
                threadId = opened.thread.id;
            }
            connection = { rpc, threadId, normalizer: new CodexNormalizer(threadId) };
            await this.deps.recordVendorId(this.sessionId, threadId);
        } catch (error) {
            rpc.close(error);
            throw error;
        }

        const ready = connection;
        this.connection = ready;
        void rpc.closed.then(() => {
            if (this.connection === ready) this.connection = null;
            // A turn still open when the agent went away will never complete.
            if (this.turn) this.turn.end("failed", null);
            if (!this.closedByUs) this.deps.log(`${this.sessionId}: the connection to Codex ended`);
        });
        return ready;
    }

    private notified(connection: Connection, method: string, params: unknown): void {
        const thread = (params as { threadId?: unknown } | null)?.threadId;
        if (typeof thread === "string" && thread !== connection.threadId) return;
        switch (method) {
            case "item/started":
            case "item/completed": {
                const event = protocol.itemEventSchema.safeParse(params);
                if (!event.success) return;
                const rows =
                    method === "item/started"
                        ? connection.normalizer.started(event.data.item)
                        : connection.normalizer.completed(event.data.item);
                if (rows.length > 0) this.store(rows);
                this.deps.touch(this.sessionId);
                return;
            }
            case "item/agentMessage/delta":
                if (protocol.itemDeltaSchema.safeParse(params).success) this.deps.touch(this.sessionId);
                return;
            case "turn/completed": {
                const event = protocol.turnCompletedSchema.safeParse(params);
                if (!event.success) return;
                const { id, status, error } = event.data.turn;
                const message = error?.message ?? null;
                if (this.turn?.id === id) this.turn.end(status, message);
                else if (this.turn && this.turn.id === null) this.early.set(id, { status, error: message });
                return;
            }
            default:
                return;
        }
    }

    private async requested(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
        if (!protocol.isApprovalMethod(method)) {
            // Answered, never left hanging: an unanswered request holds the
            // turn for good. Nothing else is consented to on anyone's behalf.
            throw new CodexRpcError(METHOD_NOT_FOUND, "Polaris does not answer this request.");
        }
        const parsed = protocol.approvalParamsSchema.safeParse(params);
        if (!parsed.success) return { decision: "cancel" };
        const prompt = protocol.approvalPrompt(method, parsed.data);
        await this.deps.recordEvents(this.sessionId, [{ kind: "permission", detail: prompt.tool, subject: prompt.tool }]);
        const status = await this.deps.ask(this.sessionId, prompt, signal).catch((error: unknown) => {
            this.deps.log(`${this.sessionId}: the approval was not put to the person`, error);
            return "expired" as const;
        });
        const decision = protocol.decisionFor(status, parsed.data.availableDecisions);
        if (decision === "accept" || decision === "acceptForSession")
            await this.deps.recordEvents(this.sessionId, [{ kind: "tool.start", detail: "", subject: prompt.tool }]);
        return { decision };
    }

    private store(rows: readonly HistoryRow[]): void {
        this.stored = this.stored
            .then(() => this.deps.storeRows(this.sessionId, rows))
            .catch((error: unknown) => this.deps.log(`${this.sessionId}: history rows were not stored`, error));
    }

    private async endTurn(connection: Connection, turn: Turn, status: string, error: string | null): Promise<void> {
        // The completion can overtake the last items' handlers by a microtask.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const rows = connection.normalizer.finish(status, turn.id ?? "turn");
        if (rows.length > 0) this.store(rows);
        await this.stored;
        if (this.turn === turn) this.turn = null;
        if (status === "failed") {
            this.deps.log(`${this.sessionId}: the turn failed`, error ?? undefined);
            await this.deps
                .recordEvents(this.sessionId, [{ kind: "turn.failed", detail: "The agent stopped before it answered.", subject: "" }])
                .catch(() => undefined);
            return;
        }
        await this.deps.recordEvents(this.sessionId, [{ kind: "turn.end", detail: "", subject: "" }]).catch(() => undefined);
    }
}
