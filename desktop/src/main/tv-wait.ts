/**
 * Waiting for the TV instead of asking the person to retry: while debugging is
 * off the port is polled, and when it opens the connection is tried; a prompt
 * nobody answered, or one answered No, shows again on the next attempt. The
 * person reads one instruction and acts on the TV; this notices on its own.
 */

/** What the person is being asked to do while this waits. */
export type TvWaitStep = "debugging" | "prompt";

/** How a connection attempt failed, as `connectFailure` names it. */
export type TvAttemptFailure = "adb-off" | "unreachable" | "not-allowed" | string;

export type TvWaitResult<T> =
    | { readonly kind: "connected"; readonly connection: T; }
    | { readonly kind: "cancelled"; }
    | { readonly kind: "timeout"; readonly step: TvWaitStep; }
    | { readonly kind: "failed"; readonly outcome: string; };

export interface TvWaitOptions<T> {
    /** Whether the debugging port answers now. */
    probe(): Promise<"open" | "refused" | "silent">;
    /** One connection attempt; throws with what `classify` reads. */
    connect(): Promise<T>;
    classify(error: unknown): TvAttemptFailure;
    onStep(step: TvWaitStep): void;
    cancelled(): boolean;
    sleep(ms: number): Promise<void>;
    now(): number;
    intervalMs: number;
    /** How long to wait in all before saying so. */
    timeoutMs: number;
}

/** The step a failed attempt leaves the person at, or null when waiting cannot help. */
export function stepAfter(failure: TvAttemptFailure): TvWaitStep | null {
    if (failure === "not-allowed") return "prompt";
    if (failure === "adb-off" || failure === "unreachable") return "debugging";
    return null;
}

/** Polls and connects until the TV lets this computer in, it is cancelled, or time runs out. */
export async function waitForTv<T>(options: TvWaitOptions<T>): Promise<TvWaitResult<T>> {
    const deadline = options.now() + options.timeoutMs;
    let step: TvWaitStep | null = null;
    const show = (next: TvWaitStep) => {
        if (next === step) return;
        step = next;
        options.onStep(next);
    };
    for (let first = true; ; first = false) {
        if (options.cancelled()) return { kind: "cancelled" };
        if (options.now() >= deadline) return { kind: "timeout", step: step ?? "debugging" };
        if (!first) await options.sleep(options.intervalMs);
        if (options.cancelled()) return { kind: "cancelled" };
        if ((await options.probe()) !== "open") {
            // A prompt already shown stays the instruction until the port really closes.
            show(step === "prompt" ? "prompt" : "debugging");
            continue;
        }
        try {
            return { kind: "connected", connection: await options.connect() };
        } catch (caught) {
            const failure = options.classify(caught);
            const next = stepAfter(failure);
            if (!next) return { kind: "failed", outcome: failure };
            show(next);
        }
    }
}
