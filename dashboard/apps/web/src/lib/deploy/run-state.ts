/**
 * What a service is doing right now, kept apart from how its last deploy went.
 *
 * The two used to be one word. A service's card showed the status of the
 * deployment it points at, and that row says "running" from the moment a release
 * finishes until another replaces it - so a service somebody stopped a week ago
 * went on reading "running" everywhere it was drawn, and its last deploy, which
 * had finished, was described as if it were still going.
 *
 * Now the deployment answers "did the release ship" and this answers "is it up":
 * the record's own intent (stopped, asleep) first, then what the machine was last
 * seen doing. The machine's side comes from the metrics collector, which samples
 * every running container once a minute and skips one that is not running - so a
 * service that should be up and has stopped appearing in those samples has stopped
 * running. That is only said when the collector is evidently working on that
 * service's machine (something there was sampled recently), because a collector
 * that never ran, or never reached the machine, is not evidence of anything.
 */

import { isInFlightStatus } from "./status";
import { FAILED_DEPLOY_STATUSES } from "./attention";

/** The states a service can be in, as every screen draws them. */
export type ServiceRunState =
    | "never"
    | "deploying"
    | "running"
    | "stopped"
    | "sleeping"
    | "crashed"
    | "failed";

/** How old the newest sample may be before a service counts as not running: three
 *  of the collector's one-minute ticks, so one slow pass is not an outage. */
export const RECENT_SAMPLE_MS = 3 * 60_000;

/** Everything the decision reads, gathered by `serviceRunStates`. */
export interface RunStateInput {
    /** The status of the build in flight, else of the release it serves; null
     *  when it was never deployed (see `getApplicationDeployStatuses`). */
    readonly deployStatus: string | null;
    /** `running` or `stopped`: what somebody asked for. */
    readonly desiredState: string;
    /** Put to sleep for being idle. */
    readonly asleep: boolean;
    /** When the serving release finished starting, if known. */
    readonly releasedAt: Date | null;
    /** The newest metrics sample of the service, if any recent one exists. */
    readonly lastSampleAt: Date | null;
    /** Whether the collector sampled anything on this service's machine lately,
     *  and can name the container it would sample. */
    readonly collectorAlive: boolean;
    readonly now: number;
}

/** Pure, so the order of these rules is pinned by a test rather than by a screen. */
export function serviceRunState(input: RunStateInput): ServiceRunState {
    if (!input.deployStatus) return "never";
    if (isInFlightStatus(input.deployStatus)) return "deploying";
    if (input.desiredState === "stopped") return "stopped";
    if (input.asleep) return "sleeping";
    const status = input.deployStatus.toLowerCase();
    if (status === "stopped" || status === "removed") return "stopped";
    if (FAILED_DEPLOY_STATUSES.includes(status) || status === "cancelled") return "failed";
    if (!input.collectorAlive) return "running";
    if (input.lastSampleAt && input.now - input.lastSampleAt.getTime() < RECENT_SAMPLE_MS) return "running";
    // Just released: the first sample has not been taken yet.
    if (input.releasedAt && input.now - input.releasedAt.getTime() < RECENT_SAMPLE_MS) return "running";
    return "crashed";
}

/** The chip tone each state wears. */
export function runStateTone(state: ServiceRunState): "success" | "warning" | "danger" | "idle" {
    if (state === "running") return "success";
    if (state === "deploying") return "warning";
    if (state === "crashed" || state === "failed") return "danger";
    return "idle";
}

/**
 * How a finished deployment's outcome reads. A release that started serving is
 * stored as "running" for as long as it serves - which says nothing about whether
 * the service is up now, and is exactly the word that misled - so it reads as the
 * outcome it is: succeeded.
 */
export function deployOutcome(status: string): string {
    const value = status.toLowerCase();
    if (value === "running" || value === "success" || value === "deployed") return "succeeded";
    if (value === "rolled_back") return "failed";
    return value;
}
