/**
 * Parse the subset of a Docker container inspect (`GET /containers/{id}/json`)
 * that the deploy UI needs: run state and health. The inspect JSON is untrusted
 * (it comes back through the daemon proxy), so every field is read defensively.
 */

export interface ContainerState {
    /** running | exited | created | restarting | ... */
    readonly status: string;
    /** healthy | unhealthy | starting | undefined (no healthcheck). */
    readonly health?: string;
    readonly exitCode?: number;
    /**
     * How many times the engine has restarted this container since it was made.
     *
     * Cumulative for its whole life, so it means nothing on its own - a container
     * that restarted twice last month reads the same as one restarting right now.
     * It is `startedAt` beside it that turns a count into a rate, and the pair is
     * what tells a crash loop from a server that is merely slow to boot.
     */
    readonly restartCount: number;
    /** When the current run began, as the daemon reports it. */
    readonly startedAt?: string;
    /**
     * True only while the engine is waiting out its backoff before trying again.
     *
     * A window of a second or two between runs, so a poll almost never lands in
     * it - which is why it corroborates a loop and never decides one.
     */
    readonly restarting?: boolean;
}

export function parseContainerState(inspect: unknown): ContainerState {
    if (typeof inspect !== "object" || inspect === null) return { status: "unknown", restartCount: 0 };
    const container = inspect as Record<string, unknown>;
    // Not under State, unlike everything else here, so it is read before the
    // early return that a container with no State block takes.
    const restartCount = typeof container.RestartCount === "number" ? container.RestartCount : 0;
    const state = container.State;
    if (typeof state !== "object" || state === null) return { status: "unknown", restartCount };
    const record = state as Record<string, unknown>;
    const health = record.Health;
    return {
        status: typeof record.Status === "string" ? record.Status : "unknown",
        health:
            typeof health === "object" && health !== null
                ? String((health as Record<string, unknown>).Status ?? "")
                : undefined,
        exitCode: typeof record.ExitCode === "number" ? record.ExitCode : undefined,
        restartCount,
        startedAt: typeof record.StartedAt === "string" ? record.StartedAt : undefined,
        restarting: typeof record.Restarting === "boolean" ? record.Restarting : undefined
    };
}
