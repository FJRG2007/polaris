/**
 * Undo and redo of a Code session's turns, on the machine the session runs on.
 *
 * The scripts are `session-snapshots.ts`; this runs them through the session's
 * own exec path - its container, or its server over SSH - and turns what they
 * said into an answer the screen can word. A session on a computer has no exec
 * path (its runner takes protocol frames, not commands), so it answers
 * `computer` rather than pretending.
 */

import * as core from "@polaris/core";
import * as snapshots from "./session-snapshots";
import { runInSession } from "./session-runtime";
import { changesUnavailable, machineOf } from "./session-review";
import type { SessionView } from "./session-service";

export type SnapshotUnavailable = "workspace" | "ended" | "starting" | "computer" | "over";

export type TurnsAnswer =
    | { kind: "listing"; listing: snapshots.TurnsListing }
    | { kind: "unavailable"; reason: SnapshotUnavailable }
    | { kind: "unreachable" };

export type StepAnswer =
    | { kind: "done"; result: snapshots.StepResult }
    | { kind: "unavailable"; reason: SnapshotUnavailable }
    | { kind: "unreachable" };

async function reachable(
    session: SessionView,
    steering: boolean
): Promise<{ workdir: string } | { reason: SnapshotUnavailable }> {
    if (session.place === "computer") return { reason: "computer" };
    // Putting files back is steering: a finished session's checkout is what was
    // kept of its work, and stays as it is.
    if (steering && core.isSessionOver(session.state)) return { reason: "over" };
    const machine = await machineOf(session.id);
    const unavailable = changesUnavailable(session, machine.hasMachine);
    return unavailable ? { reason: unavailable } : { workdir: machine.workdir };
}

/** The session's newest turns and where an undo stands. */
export async function listSessionTurns(session: SessionView): Promise<TurnsAnswer> {
    const place = await reachable(session, false);
    if ("reason" in place) return { kind: "unavailable", reason: place.reason };
    try {
        const result = await runInSession(session.id, snapshots.listTurnsScript(place), { evenIfFinished: true });
        const listing = snapshots.parseTurns(result.output);
        if (listing) return { kind: "listing", listing };
        console.error(`polaris: listing the turns of session ${session.id} said nothing usable`);
    } catch (error) {
        console.error(`polaris: could not list the turns of session ${session.id}:`, error);
    }
    return { kind: "unreachable" };
}

/** Step the checkout back (`undo`, to before `to` when given) or forward. */
export async function stepSessionTurn(
    session: SessionView,
    input: { direction: "undo" | "redo"; to?: string }
): Promise<StepAnswer> {
    const place = await reachable(session, true);
    if ("reason" in place) return { kind: "unavailable", reason: place.reason };
    const script =
        input.direction === "undo"
            ? snapshots.undoScript({ workdir: place.workdir, to: input.to })
            : snapshots.redoScript({ workdir: place.workdir });
    try {
        const said = snapshots.parseStep((await runInSession(session.id, script)).output);
        if (said) return { kind: "done", result: said };
        console.error(`polaris: a ${input.direction} in session ${session.id} said nothing usable`);
    } catch (error) {
        console.error(`polaris: could not ${input.direction} in session ${session.id}:`, error);
    }
    return { kind: "unreachable" };
}
