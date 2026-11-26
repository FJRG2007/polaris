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
import { connectAcp, supportsSteering, type AcpClient } from "./client";
import type { HistoryRow } from "../transcript-decoders";
import type { PermissionStatus } from "../session-permissions";
import { elicitationQuestions, elicitationReply, type ElicitationReply } from "./elicitation";
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
    /**
     * The agent would not reopen the session's stored conversation (its
     * transcript is not in this home): what to put in front of the next
     * prompt so the new conversation still knows the old one, or null. Shown
     * on the thread as one notice line, never as the prompt it builds.
     */
    resumeRefused?(sessionId: string): Promise<string | null>;
    pipe(sessionId: string): Promise<PipeIo>;
    storeRows(sessionId: string, rows: readonly HistoryRow[]): Promise<unknown>;
    recordEvents(
        sessionId: string,
        events: readonly { kind: core.AgentSessionEventKind; detail: string; subject: string }[]
    ): Promise<unknown>;
    recordVendorId(sessionId: string, vendorSessionId: string): Promise<void>;
    permission(sessionId: string): (request: acp.RequestPermissionRequest, signal: AbortSignal) => Promise<string | null>;
    /** Put a question to the person as the session's prompt card; resolves
     *  to their answer. Without it a question form is cancelled. */
    ask?(
        sessionId: string,
        request: { tool: string; detail: string; input: { questions: unknown[] }; carriesReason: boolean },
        signal: AbortSignal
    ): Promise<{ status: PermissionStatus; answer?: unknown }>;
    /** Signal the agent's processes, for a Stop it did not honour. */
    signal?(sessionId: string, signal: "INT" | "TERM"): Promise<unknown>;
    /** A turn ended well - one Polaris sent or one the agent started itself:
     *  the session's next queued message goes now. */
    turnEnded?(sessionId: string): Promise<unknown>;
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
    /** Overrides of the timings below, for tests. */
    cycleQuietMs?: number;
    cycleIdleMs?: number;
    stopGraceMs?: number;
}

const STEP_DETAIL_CHARS = 200;

/**
 * The step events a batch of rows stands for, the way a hook reports them in
 * a terminal session: a call announced is `tool.start`, its result `tool.end`
 * or `tool.failed`. A call described again is the same step and adds none.
 * What the thread counts and the workspace wakes on (`lastToolAt`). Pure.
 */
export function stepEvents(
    rows: readonly HistoryRow[],
    names: { titleOf(ref: string): string }
): { kind: core.AgentSessionEventKind; detail: string; subject: string }[] {
    const events: { kind: core.AgentSessionEventKind; detail: string; subject: string }[] = [];
    for (const row of rows) {
        if (row.kind === "tool" && !row.replace)
            events.push({ kind: "tool.start", detail: row.body.slice(0, STEP_DETAIL_CHARS), subject: row.subject });
        else if (row.kind === "result")
            events.push({
                kind: row.subject === "error" ? "tool.failed" : "tool.end",
                detail: "",
                subject: names.titleOf(row.ref)
            });
    }
    return events;
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

/** What a turn that lost its agent reports: the next message starts the
 *  agent again on the same conversation (`session/load`). */
export const AGENT_EXITED = "The agent's process ended. Send a message to start it again.";

/** How long the agent's own activity may go quiet, with no step it started
 *  still open, before that activity counts as a finished turn. */
const CYCLE_QUIET_MS = 5_000;
/** How long it may go quiet with a step still open. */
const CYCLE_IDLE_MS = 120_000;
/** Between a Stop and each harder way of stopping: `INT`, `TERM`, then the
 *  connection closed. */
const STOP_GRACE_MS = 3_000;
/** How long a question the agent asked waits for the person. Longer than a
 *  hook's permission prompt: nothing on the machine times the form out. */
export const ASK_WAIT_MS = 30 * 60_000;

/** Updates that are the agent at work, as opposed to its bookkeeping
 *  (modes, commands, usage). */
const ACTIVITY = new Set(["agent_message_chunk", "agent_thought_chunk", "tool_call", "tool_call_update", "plan"]);

type SessionEvent = { kind: core.AgentSessionEventKind; detail: string; subject: string; };

interface Connection {
    client: AcpClient;
    acpSessionId: string;
    normalizer: AcpNormalizer;
    modes: readonly acp.SessionMode[];
    /** Updates are dropped while a loaded conversation replays: they are
     *  already the session's history. */
    replaying: boolean;
    /** Whether the agent takes a message into a running turn. */
    steering: boolean;
}

/**
 * Work the agent started on its own, with no prompt of Polaris's open: Claude
 * Code wakes when a background task or a Monitor it armed reports, and runs a
 * turn nobody sent. ACP v1 has no end for it (the adapter reports foreground
 * state only to v2 clients), so it ends when the agent goes quiet.
 */
interface Cycle {
    /** Tool calls the cycle started and has not finished. */
    readonly open: Set<string>;
    timer: ReturnType<typeof setTimeout> | null;
}

export class AcpSessionDriver {
    private connection: Connection | null = null;
    private opening: Promise<Connection> | null = null;
    private turn: Promise<void> | null = null;
    private cycle: Cycle | null = null;
    /** Set by a Stop until the turn it stopped has ended. */
    private stopping = false;
    private stopTimers: ReturnType<typeof setTimeout>[] = [];
    /** Requests (a permission, a question) waiting on the person: the agent's
     *  silence meanwhile is not the end of its work. */
    private asking = 0;
    /** The summary the next prompt carries after a refused `session/load`. */
    private carried: string | null = null;
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

    /** Whether a turn is running, Polaris's or one the agent started itself. */
    get busy(): boolean {
        return this.turn !== null || this.cycle !== null;
    }

    /** Send a message. Returns once the agent has it; the turn runs on. */
    async prompt(text: string): Promise<void> {
        // A turn being stopped is over for the person: the message waits for
        // the agent to let go of it (bounded by the stop's escalation).
        if (this.turn && this.stopping) await this.turn;
        if (this.turn) throw new AcpRefusal("The agent is still on the last message. Stop it or wait for it to finish.");
        const connection = await this.connect();
        // The agent's own work is taken over by this turn, as the adapter
        // does: its end is this turn's end.
        this.dropCycle();
        await this.deps.recordEvents(this.sessionId, [{ kind: "prompt", detail: "", subject: "" }]);
        const carried = this.carried;
        this.carried = null;
        const run = connection.client.prompt(connection.acpSessionId, carried ? `${carried}\n\n${text}` : text);
        this.turn = run.then(
            (response) => this.endTurn(connection, response.stopReason, null),
            (error: unknown) => this.endTurn(connection, undefined, error)
        );
    }

    /**
     * Deliver a message into the running turn, the way the agent's own CLI
     * takes one typed while it works. False when no turn is running here or
     * the agent cannot take one; the caller queues the message.
     */
    async steer(text: string): Promise<boolean> {
        const connection = this.connection;
        if (!this.busy || this.stopping || !connection?.steering) return false;
        return (await connection.client.steer(connection.acpSessionId, text)) === "injected";
    }

    /**
     * Stop whatever the agent is running. `session/cancel` is a notification
     * the agent may take its time over (or never honour), so the session
     * leaves "working" at once, and a turn not ended a few seconds later is
     * stopped harder: `INT` to the agent's processes, then `TERM`, then the
     * connection closed - the next message starts it again on the same
     * conversation.
     */
    async cancel(): Promise<boolean> {
        // A driver that did not start the turn (the dashboard restarted or
        // updated mid-turn) still asks: session/cancel stops whatever the
        // agent is running in the session, whoever sent it.
        const connection = this.connection ?? (await this.connect().catch(() => null));
        if (!connection) return false;
        // All before the first wait, so the turn's own end (the agent may
        // answer the cancel at once) finds it stopping and lands after.
        const turn = this.turn;
        let recorded: Promise<unknown>;
        if (!turn && this.cycle) recorded = this.endCycle(connection, "cancelled");
        else {
            if (turn && !this.stopping) {
                this.stopping = true;
                this.escalate(turn);
            }
            recorded = this.recordChained([{ kind: "turn.end", detail: "", subject: "" }]);
        }
        await connection.client.cancel(connection.acpSessionId).catch((error: unknown) => {
            this.deps.log(`${this.sessionId}: session/cancel did not reach the agent`, error);
        });
        await recorded;
        return true;
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
        this.dropCycle();
        this.clearStop();
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
                const update = notification.update;
                // Activity with no prompt open is the agent's own turn.
                if (!this.turn && ACTIVITY.has(update.sessionUpdate)) this.noteCycle(connection, update);
                const rows = connection.normalizer.push(update);
                if (rows.length > 0) this.store(rows);
                const steps = stepEvents(rows, connection.normalizer);
                // After the rows, so a page woken by the event finds the step.
                // Not for a turn being stopped: the session already left it.
                if (steps.length > 0 && !this.stopping) this.recordSteps(steps);
                const draft = connection.normalizer.draft();
                if (draft) this.draft.set(draft.id, draft.text);
                else this.draft.end();
                if (update.sessionUpdate === "current_mode_update") return;
                // A chunk that completed nothing changed nothing stored: the
                // draft carries it, and a page need not read the session again.
                if (update.sessionUpdate === "agent_message_chunk" && rows.length === 0) return;
                this.deps.touch(this.sessionId);
            },
            onPermission: (request, signal) =>
                this.asked(async () => {
                    const ask = this.deps.permission(this.sessionId);
                    const tool = (request.toolCall.title?.trim() || request.toolCall.kind || "tool").slice(0, 80);
                    await this.recordChained([{ kind: "permission", detail: tool, subject: tool }]);
                    const chosen = await ask(request, signal);
                    // Back to working once answered: the `permission` event left
                    // the session waiting, and the call's own row said so before.
                    if (!this.stopping) await this.recordChained([{ kind: "tool.start", detail: "", subject: tool }]);
                    return chosen;
                }),
            onElicitation: (request, signal) => this.elicited(request, signal),
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
                replaying: true,
                steering: supportsSteering(init)
            };
            if (init.agentCapabilities?.loadSession && session.vendorSessionId) {
                connection.acpSessionId = session.vendorSessionId;
                try {
                    const loaded = await client.loadSession(session.vendorSessionId, session.workdir);
                    acpSessionId = session.vendorSessionId;
                    modes = loaded.modes?.availableModes ?? [];
                } catch (error) {
                    this.deps.log(`${this.sessionId}: the agent would not reopen its conversation, starting a new one`, error);
                    this.carried = (await this.deps.resumeRefused?.(this.sessionId).catch(() => null)) ?? null;
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
        void client.closed.then(async () => {
            if (this.connection === ready) this.connection = null;
            if (this.closedByUs) return;
            this.deps.log(`${this.sessionId}: the connection to the agent ended`);
            // The agent's own work died with it. A prompt's turn ends through
            // its rejected request (`endTurn`).
            if (this.cycle && !this.turn) await this.endCycle(ready, "failed");
        });
        return ready;
    }

    /** A question form from the agent, put to the person as the session's
     *  AskUserQuestion card and answered in the adapter's fields. */
    private async elicited(request: unknown, signal: AbortSignal): Promise<ElicitationReply> {
        const questions = elicitationQuestions(request);
        if (!questions || !this.deps.ask) return { action: "cancel" };
        return this.asked(async () => {
            const tool = "AskUserQuestion";
            await this.recordChained([{ kind: "question", detail: questions[0]!.question.slice(0, STEP_DETAIL_CHARS), subject: tool }]);
            const answered = await this.deps.ask!(
                this.sessionId,
                {
                    tool,
                    detail: questions.map((question) => question.question).join("\n").slice(0, STEP_DETAIL_CHARS),
                    input: { questions },
                    // One question takes a message sent instead as its
                    // "Other" answer; several are skipped and the message follows.
                    carriesReason: questions.length === 1
                },
                signal
            );
            if (!this.stopping) await this.recordChained([{ kind: "tool.start", detail: "", subject: tool }]);
            return elicitationReply(questions, answered.status, answered.answer);
        });
    }

    /** Run a request that waits on the person, holding off the end of the
     *  agent's own work meanwhile. */
    private async asked<T>(work: () => Promise<T>): Promise<T> {
        this.asking += 1;
        if (this.cycle?.timer) clearTimeout(this.cycle.timer);
        try {
            return await work();
        } finally {
            this.asking -= 1;
            const connection = this.connection;
            if (this.cycle && connection) this.armCycle(connection, this.cycle);
        }
    }

    /** Activity with no prompt open: start (or keep alive) the agent's own turn. */
    private noteCycle(connection: Connection, update: acp.SessionUpdate): void {
        const cycle = (this.cycle ??= { open: new Set(), timer: null });
        if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
            const done = update.status === "completed" || update.status === "failed";
            if (done) cycle.open.delete(update.toolCallId);
            else if (update.sessionUpdate === "tool_call") cycle.open.add(update.toolCallId);
        }
        this.armCycle(connection, cycle);
    }

    private armCycle(connection: Connection, cycle: Cycle): void {
        if (cycle.timer) clearTimeout(cycle.timer);
        cycle.timer = null;
        if (this.asking > 0) return;
        const wait =
            cycle.open.size === 0
                ? (this.deps.cycleQuietMs ?? CYCLE_QUIET_MS)
                : (this.deps.cycleIdleMs ?? CYCLE_IDLE_MS);
        cycle.timer = setTimeout(() => {
            if (this.cycle === cycle) void this.endCycle(connection, "end");
        }, wait);
    }

    private dropCycle(): void {
        if (this.cycle?.timer) clearTimeout(this.cycle.timer);
        this.cycle = null;
    }

    /** The end of the agent's own turn, recorded the way a prompt's is. */
    private async endCycle(connection: Connection, how: "end" | "cancelled" | "failed"): Promise<void> {
        if (!this.cycle) return;
        this.dropCycle();
        const rows = connection.normalizer.finish(how === "cancelled" ? "cancelled" : undefined);
        this.draft.end();
        if (rows.length > 0) this.store(rows);
        await this.recordChained([
            how === "failed"
                ? { kind: "turn.failed", detail: AGENT_EXITED, subject: "" }
                : { kind: "turn.end", detail: "", subject: "" }
        ]);
        if (how !== "failed") this.ended();
    }

    /** A Stop the agent has not honoured yet, made harder step by step. */
    private escalate(turn: Promise<void>): void {
        const grace = this.deps.stopGraceMs ?? STOP_GRACE_MS;
        const still = () => this.turn === turn;
        const steps: (() => unknown)[] = [
            () => this.deps.signal?.(this.sessionId, "INT"),
            () => this.deps.signal?.(this.sessionId, "TERM"),
            // Whatever is left of it: the turn ends with the connection, and
            // the next message starts the agent again.
            () => this.connection?.client.close(new Error("The agent did not stop."))
        ];
        steps.forEach((step, index) => {
            this.stopTimers.push(
                setTimeout(() => {
                    if (!still()) return;
                    this.deps.log(`${this.sessionId}: the agent did not stop, stopping it harder (${index + 1})`);
                    void Promise.resolve()
                        .then(step)
                        .catch((error: unknown) => this.deps.log(`${this.sessionId}: the agent was not signalled`, error));
                }, grace * (index + 1))
            );
        });
    }

    private clearStop(): void {
        for (const timer of this.stopTimers) clearTimeout(timer);
        this.stopTimers = [];
        this.stopping = false;
    }

    /** A turn ended well: what the session does next (the queue) is the deps'. */
    private ended(): void {
        if (!this.deps.turnEnded) return;
        void Promise.resolve()
            .then(() => this.deps.turnEnded!(this.sessionId))
            .catch((error: unknown) => this.deps.log(`${this.sessionId}: the turn's end was not followed up`, error));
    }

    /** Events in the order of the rows before them. */
    private recordChained(events: readonly SessionEvent[]): Promise<unknown> {
        this.stored = this.stored
            .then(() => this.deps.recordEvents(this.sessionId, events))
            .catch((error: unknown) => this.deps.log(`${this.sessionId}: session events were not recorded`, error));
        return this.stored;
    }

    private recordSteps(events: readonly SessionEvent[]): void {
        void this.recordChained(events);
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
        const stopped = this.stopping;
        // A request rejected because the connection ended: the agent is gone.
        const lost =
            error !== null &&
            (await Promise.race([
                connection.client.closed.then(() => true),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 0))
            ]));
        const rows = connection.normalizer.finish(stopped ? "cancelled" : stopReason);
        this.draft.end();
        if (rows.length > 0) this.store(rows);
        // From here on, activity is the agent's own (`noteCycle`), and its
        // events land after this turn's end.
        this.turn = null;
        this.clearStop();
        let event: SessionEvent | null = null;
        if (stopped) {
            // Recorded when the Stop was pressed.
            if (error !== null) this.deps.log(`${this.sessionId}: the stopped turn ended with an error`, error);
        } else if (error !== null) {
            this.deps.log(`${this.sessionId}: the turn failed`, error);
            event = { kind: "turn.failed", detail: lost ? AGENT_EXITED : "The agent stopped before it answered.", subject: "" };
        } else if (stopReason === "refusal") {
            event = { kind: "turn.failed", detail: "The agent declined to carry on.", subject: "" };
        } else {
            event = { kind: "turn.end", detail: "", subject: "" };
        }
        await (event ? this.recordChained([event]) : this.stored);
        // A failed turn holds the queue, as a hook-reported one does.
        if (!event || event.kind === "turn.end") this.ended();
    }
}
