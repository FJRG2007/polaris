/**
 * The deploy state vocabulary: where a deployment stops, and what counts as still
 * moving.
 *
 * One module because the pipeline that writes these states, the queries that read
 * them and the screens that render them all ask the same two questions, and the
 * copies they each kept drifted: one left "running" out and polled a service that
 * had been up for hours, another had no notion of a build at all and showed one that
 * was cloning its repository as if nothing were happening.
 */

/** The states a deployment never moves out of. Read by four separate decisions:
 *  whether a queued job should still run, whether a verdict may overwrite the row,
 *  whether a screen keeps looking, and what a service's card says it is doing. */
export const TERMINAL_DEPLOY_STATUSES = new Set([
    "running",
    "success",
    "failed",
    "cancelled",
    "rolled_back",
    "stopped",
    "removed"
]);

/** Deployment states with work still happening behind them. Spelled out rather than
 *  taken as "not terminal", so a state nobody here recognises leaves a screen alone
 *  instead of leaving it looking forever. */
export const IN_FLIGHT_DEPLOY_STATUSES = ["queued", "deploying"] as const;

/** The same for a managed database, which provisions its volume before it runs. */
export const IN_FLIGHT_DATABASE_STATUSES = ["queued", "provisioning", "deploying"] as const;

const IN_FLIGHT = new Set<string>([...IN_FLIGHT_DEPLOY_STATUSES, ...IN_FLIGHT_DATABASE_STATUSES]);

/** Whether a service or database is on its way somewhere, so the screen showing it
 *  has a reason to look again. */
export function isInFlightStatus(status: string | null | undefined): boolean {
    return status ? IN_FLIGHT.has(status.toLowerCase()) : false;
}
