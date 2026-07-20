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
}

export function parseContainerState(inspect: unknown): ContainerState {
    if (typeof inspect !== "object" || inspect === null) return { status: "unknown" };
    const state = (inspect as Record<string, unknown>).State;
    if (typeof state !== "object" || state === null) return { status: "unknown" };
    const record = state as Record<string, unknown>;
    const health = record.Health;
    return {
        status: typeof record.Status === "string" ? record.Status : "unknown",
        health:
            typeof health === "object" && health !== null
                ? String((health as Record<string, unknown>).Status ?? "")
                : undefined,
        exitCode: typeof record.ExitCode === "number" ? record.ExitCode : undefined
    };
}
