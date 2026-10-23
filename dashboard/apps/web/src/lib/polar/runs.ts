/**
 * Polar answers that keep going when nobody is looking.
 *
 * A turn used to live as long as the request that asked for it: switching to
 * another chat closed that request, and the answer stopped half-way. Now each
 * turn is a run held here, with its own stop switch, so several chats can
 * answer at once and the person can come back to any of them.
 *
 * The run keeps the answer's stream as it was sent (server-sent events, one
 * chunk per entry) so a chat opened again replays it from the start and then
 * follows it live - the replay `useChat({ resume: true })` expects from
 * `GET /api/polar/chat/[id]/stream`. When it ends, the person is told in the
 * bell if no screen was watching it.
 *
 * Owner-scoped: every read and stop names the user, and a thread that is not
 * theirs answers as if nothing ran.
 */

/** What a chat's newest turn is doing, as its row in the sidebar shows it. */
export type PolarRunState = "running" | "approval" | "done" | "failed" | "stopped";

/** A run as the sidebar reads it. */
export interface PolarRunView {
    threadId: string;
    state: PolarRunState;
    /** It ended while no screen was on it, and it was not opened since. */
    unread: boolean;
    startedAt: number;
}

/** How a run ended, for whoever is told about it. */
export interface PolarRunEnd {
    userId: string;
    threadId: string;
    state: Exclude<PolarRunState, "running">;
    /** Whether any screen was following it when it ended. */
    watched: boolean;
    /** Why a failed run stopped, as the answer's failure part said it. */
    failure?: { code: string; kind?: string; provider?: string } | null;
}

interface Run {
    userId: string;
    threadId: string;
    startedAt: number;
    endedAt: number | null;
    state: PolarRunState;
    unread: boolean;
    chunks: string[];
    bytes: number;
    /** Past the buffer cap: it still runs, but can no longer be replayed. */
    replayable: boolean;
    listeners: Set<(chunk: string | null) => void>;
    /** Screens following it: the request that started it, and each resume. */
    watchers: number;
    /** When the last screen stopped following it, 0 while none has. */
    leftAt: number;
    /** The failure part the answer carried, if any. */
    failure: PolarRunEnd["failure"];
    controller: AbortController;
    onEnd: (end: PolarRunEnd) => void;
}

/** Most runs one person may have going at once. */
export const POLAR_RUNS_MAX = 6;
/** Most of one answer kept for a replay. */
const REPLAY_BYTES_MAX = 4 * 1024 * 1024;
/**
 * A screen that let go this close to the end still saw it. The browser reads
 * its copy of the stream ahead of the copy kept here, and the chat hangs up the
 * moment it reads an error - so on a failed answer the screen was always gone
 * by the time this copy reached the end, and a run the person watched fail in
 * front of them was announced as one they had left.
 */
export const WATCH_GRACE_MS = 3_000;
/** How long an ended run stays listed: long enough to be seen in the sidebar. */
const ENDED_TTL_MS = 30 * 60_000;

const store = globalThis as typeof globalThis & { __polarRuns?: Map<string, Run> };
// enigma: one process holds the runs; a second dashboard replica would need
// them in Redis (`resumable-stream`) - Polaris runs one web container.
const runs: Map<string, Run> = (store.__polarRuns ??= new Map());

function sweep(now: number): void {
    for (const [id, run] of runs)
        if (run.endedAt !== null && now - run.endedAt > ENDED_TTL_MS) runs.delete(id);
}

function isLive(run: Run | undefined): run is Run {
    return !!run && run.state === "running" && !run.controller.signal.aborted;
}

/** One server-sent chunk's object, or null for a keep-alive or the end marker. */
function chunkObject(chunk: string): Record<string, unknown> | null {
    const data = chunk.startsWith("data: ") ? chunk.slice(6).trim() : "";
    if (!data || data === "[DONE]") return null;
    try {
        const parsed: unknown = JSON.parse(data);
        return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
        return null;
    }
}

/** The type of one server-sent chunk, or null for a keep-alive or the end marker. */
export function chunkType(chunk: string): string | null {
    const parsed = chunkObject(chunk);
    return parsed && "type" in parsed ? String(parsed.type) : null;
}

/** The failure a `data-polar-failure` chunk names, or null. */
export function chunkFailure(chunk: string): NonNullable<PolarRunEnd["failure"]> | null {
    const parsed = chunkObject(chunk);
    if (parsed?.type !== "data-polar-failure") return null;
    const data = parsed.data as Record<string, unknown> | null | undefined;
    if (!data || typeof data.code !== "string") return null;
    return {
        code: data.code.slice(0, 40),
        ...(typeof data.kind === "string" ? { kind: data.kind.slice(0, 40) } : {}),
        ...(typeof data.provider === "string" ? { provider: data.provider.slice(0, 80) } : {})
    };
}

/** Counts one screen as following a run until `signal` aborts. */
function follow(run: Run, signal: AbortSignal, onLeave?: () => void): void {
    run.watchers += 1;
    signal.addEventListener(
        "abort",
        () => {
            run.watchers -= 1;
            run.leftAt = Date.now();
            onLeave?.();
        },
        { once: true }
    );
}

export type BeginRefusal = "busy" | "too_many";

/** A run being started: its stop switch, and where its stream goes. */
export interface PolarRunHandle {
    signal: AbortSignal;
    /** Takes the copy of the answer's stream (`consumeSseStream`). */
    consume: (input: { stream: ReadableStream<string> }) => void;
    /** Counts a screen as following the run until `signal` aborts. */
    watch: (signal: AbortSignal) => void;
}

/**
 * Starts a run for a thread, or says why not: the thread already has one
 * going, or the person has as many going as one person may.
 */
export function beginPolarRun(
    userId: string,
    threadId: string,
    onEnd: (end: PolarRunEnd) => void = () => undefined,
    now = Date.now()
): PolarRunHandle | BeginRefusal {
    sweep(now);
    const current = runs.get(threadId);
    if (current && current.userId !== userId) return "busy";
    if (isLive(current)) return "busy";
    let going = 0;
    for (const run of runs.values()) if (run.userId === userId && isLive(run)) going += 1;
    if (going >= POLAR_RUNS_MAX) return "too_many";

    const run: Run = {
        userId,
        threadId,
        startedAt: now,
        endedAt: null,
        state: "running",
        unread: false,
        chunks: [],
        bytes: 0,
        replayable: true,
        listeners: new Set(),
        watchers: 0,
        leftAt: 0,
        failure: null,
        controller: new AbortController(),
        onEnd
    };
    runs.set(threadId, run);

    const watch = (signal: AbortSignal) => {
        if (signal.aborted) return;
        follow(run, signal);
    };

    const consume = ({ stream }: { stream: ReadableStream<string> }) => {
        void (async () => {
            let approval = false;
            let failed = false;
            const reader = stream.getReader();
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    const type = chunkType(value);
                    if (type === "tool-approval-request") approval = true;
                    else if (type === "error") failed = true;
                    else if (type === "data-polar-failure") run.failure = chunkFailure(value);
                    if (run.replayable) {
                        run.bytes += value.length;
                        if (run.bytes > REPLAY_BYTES_MAX) {
                            run.replayable = false;
                            run.chunks = [];
                        } else run.chunks.push(value);
                    }
                    for (const listener of run.listeners) listener(value);
                }
            } catch {
                failed = true;
            }
            finish(
                run,
                run.controller.signal.aborted
                    ? "stopped"
                    : failed
                      ? "failed"
                      : approval
                        ? "approval"
                        : "done"
            );
        })();
    };

    return { signal: run.controller.signal, consume, watch };
}

function finish(run: Run, state: Exclude<PolarRunState, "running">): void {
    run.state = state;
    run.endedAt = Date.now();
    run.chunks = [];
    for (const listener of run.listeners) listener(null);
    run.listeners.clear();
    // The newest run of the thread is the one that speaks; a stopped one was
    // stopped by the person, who needs no telling.
    if (runs.get(run.threadId) !== run || state === "stopped") return;
    const watched =
        run.watchers > 0 || (run.leftAt > 0 && run.endedAt - run.leftAt <= WATCH_GRACE_MS);
    run.unread = !watched;
    try {
        run.onEnd({
            userId: run.userId,
            threadId: run.threadId,
            state,
            watched,
            ...(state === "failed" ? { failure: run.failure } : {})
        });
    } catch (error) {
        console.error("polar: could not tell about a finished run", error);
    }
}

/**
 * The answer a thread is giving right now, from its first chunk, followed live
 * until it ends; null when nothing is running there for this person. Opening
 * the chat counts as reading what it ended with.
 */
export function replayPolarRun(
    userId: string,
    threadId: string,
    signal?: AbortSignal
): ReadableStream<string> | null {
    const run = runs.get(threadId);
    if (!run || run.userId !== userId || signal?.aborted) return null;
    run.unread = false;
    if (!isLive(run) || !run.replayable) return null;
    let listener: ((chunk: string | null) => void) | null = null;
    const detach = () => {
        if (listener) run.listeners.delete(listener);
        listener = null;
    };
    return new ReadableStream<string>({
        start(controller) {
            for (const chunk of run.chunks) controller.enqueue(chunk);
            listener = (chunk) => {
                if (chunk === null) {
                    detach();
                    controller.close();
                } else controller.enqueue(chunk);
            };
            run.listeners.add(listener);
            if (signal) follow(run, signal, detach);
        },
        cancel: detach
    });
}

/** Stops a thread's running answer; false when there was none of this person's. */
export function stopPolarRun(userId: string, threadId: string): boolean {
    const run = runs.get(threadId);
    if (!isLive(run) || run.userId !== userId) return false;
    run.controller.abort();
    return true;
}

/** The person's runs worth a mark in the sidebar, newest first. */
export function listPolarRuns(userId: string, now = Date.now()): PolarRunView[] {
    sweep(now);
    const views: PolarRunView[] = [];
    for (const run of runs.values()) {
        if (run.userId !== userId) continue;
        const marked = run.state === "running" || run.state === "approval" || run.unread;
        if (!marked) continue;
        views.push({
            threadId: run.threadId,
            state: run.state,
            unread: run.unread,
            startedAt: run.startedAt
        });
    }
    return views.sort((a, b) => b.startedAt - a.startedAt);
}

/** Test seam: forgets every run. */
export function resetPolarRuns(): void {
    runs.clear();
}
