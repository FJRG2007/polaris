/**
 * Where a deploy is, as a row of steps.
 *
 * Read from what the deploy has already written: the deployment's status, and
 * the `==> <step>...` / `==> <step>: 12.3s` lines the runtime prints around each
 * phase (`timer()` in the compose runtime). Nothing new is recorded for it, so a
 * deploy from before this existed still draws - from its status alone.
 *
 * Pure and dependency-free, so the log route can answer with the steps instead
 * of a whole log, and the same answer is drawn from a log already on screen.
 */

export type DeployStepId = "queued" | "source" | "build" | "keep" | "start" | "live";
export type DeployStepState = "done" | "current" | "failed" | "pending" | "skipped" | "warning";

export interface DeployStep {
    readonly id: DeployStepId;
    readonly label: string;
    readonly state: DeployStepState;
    /** How long it took, when the log says. */
    readonly seconds?: number;
}

/** A status the deploy will not leave. */
const ENDED_BADLY = new Set(["failed", "cancelled", "rolled_back"]);

interface Marker {
    started: boolean;
    ended: boolean;
    seconds?: number;
}

function marker(log: string, label: RegExp): Marker {
    const start = new RegExp(`^==> ${label.source}\\.\\.\\.`, "m");
    const end = new RegExp(`^==> ${label.source}: (?:[^\\n]*, )?([0-9.]+)s`, "m");
    const finished = end.exec(log);
    return {
        started: start.test(log) || finished !== null,
        ended: finished !== null,
        ...(finished ? { seconds: Number(finished[1]) } : {})
    };
}

/** The steps of one deployment, in order, each with where it stands. */
export function deploySteps(status: string, log: string): DeployStep[] {
    const rollback = /Rolling back to the kept image/.test(log);
    // An image reference has dots and colons of its own (`ghcr.io/o/app:1.2`),
    // so it is matched lazily up to the step's own `...` or `: `.
    const pull = marker(log, /Pulling \S+?/);
    const fetch = marker(log, /Fetching the source/);
    const build = marker(log, /Building the image/);
    const start = marker(log, /Starting the containers/);
    const kept = /Kept this release as /.test(log);
    const notKept = /could not be kept for an instant rollback/.test(log);

    const source: Marker = rollback
        ? { started: true, ended: true }
        : fetch.started
          ? fetch
          : pull;
    const keep: Marker = rollback
        ? { started: true, ended: true }
        : { started: kept || notKept, ended: kept || notKept };

    const rows: Array<{ id: DeployStepId; label: string; mark: Marker; skip: boolean; warn?: boolean }> = [
        { id: "queued", label: "Queued", mark: { started: status !== "queued", ended: status !== "queued" }, skip: false },
        {
            id: "source",
            label: rollback ? "Kept image" : fetch.started ? "Clone" : pull.started ? "Pull" : "Source",
            mark: source,
            skip: false
        },
        // An image source and a rollback have nothing to build.
        { id: "build", label: "Build", mark: build, skip: rollback || (pull.started && !fetch.started) },
        { id: "keep", label: "Keep", mark: keep, skip: false, warn: notKept && !rollback },
        { id: "start", label: "Start", mark: start, skip: false },
        { id: "live", label: "Live", mark: { started: status === "running", ended: status === "running" }, skip: false }
    ];

    // A deploy with no step lines at all - the swarm runtime, or one from before
    // they were written - is drawn from its status.
    const anyMarker = source.started || build.started || keep.started || start.started;
    const running = status === "running" || status === "stopped" || status === "removed";
    const failed = ENDED_BADLY.has(status);

    const steps: DeployStep[] = [];
    // The furthest step the log reached, which is where a failure happened.
    const reached = rows.reduce((furthest, row, index) => (row.mark.started ? index : furthest), 0);
    let current = -1;
    if (!running && !failed) {
        const open = rows.findIndex((row) => row.mark.started && !row.mark.ended && !row.skip);
        current = open >= 0 ? open : rows.findIndex((row) => !row.mark.started && !row.skip);
    }

    rows.forEach((row, index) => {
        const seconds = row.mark.seconds;
        let state: DeployStepState;
        if (row.skip) state = "skipped";
        else if (running) state = row.mark.started || !anyMarker || row.id === "live" ? "done" : "skipped";
        else if (failed) {
            if (row.id === "queued") state = "done";
            else if (index < reached || (index === reached && row.mark.ended)) state = "done";
            else if (index === reached || (reached === 0 && index === 1)) state = "failed";
            else state = "pending";
        } else if (index === current) state = "current";
        else if (row.mark.ended || (current >= 0 && index < current)) state = "done";
        else state = "pending";
        if (state === "done" && row.warn) state = "warning";
        steps.push({ id: row.id, label: row.label, state, ...(seconds !== undefined ? { seconds } : {}) });
    });

    // A failure whose last step had finished (it failed between steps) lands on
    // the step after it, which is the one that did not happen.
    if (failed && !steps.some((step) => step.state === "failed")) {
        const next = steps.findIndex((step) => step.state === "pending");
        if (next >= 0) steps[next] = { ...steps[next]!, state: "failed" };
    }
    return steps;
}
