/**
 * Undo and redo of a Code session's turns, on the machine the session runs on.
 *
 * The scripts are `session-snapshots.ts`; this runs them through the session's
 * own exec path - its container, or its server over SSH - and turns what they
 * said into an answer the screen can word. A session on a computer is asked
 * through its runner instead (`snapshot.run`), which does the same with git
 * there; a desktop too old to know that frame answers `computer`.
 */

import * as core from "@polaris/core";
import * as snapshots from "./session-snapshots";
import { runInSession } from "./session-runtime";
import { changesUnavailable, computerCheckout, machineOf } from "./session-review";
import { runComputerSnapshot, runnerSnapshots } from "@/lib/computers/computer-workspace";
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

type Place = { workdir: string } | { computer: { id: string; runnerId: string } } | { reason: SnapshotUnavailable };

async function reachable(session: SessionView, steering: boolean): Promise<Place> {
    const over = core.isSessionOver(session.state);
    // Putting files back is steering: a finished session's checkout is what was
    // kept of its work, and stays as it is.
    if (steering && over) return { reason: "over" };
    if (session.place === "computer") {
        if (!session.repoFullName && !session.localFolder) return { reason: "workspace" };
        const computer = computerCheckout(session);
        if (!computer) return { reason: over ? "ended" : "starting" };
        return (await runnerSnapshots(computer.runnerId)) ? { computer } : { reason: "computer" };
    }
    const machine = await machineOf(session.id);
    const unavailable = changesUnavailable(session, machine.hasMachine);
    return unavailable ? { reason: unavailable } : { workdir: machine.workdir };
}

/** A computer's listing, in this module's words. Pure. */
export function computerTurns(answer: core.SnapshotAnswer | null): TurnsAnswer {
    if (answer?.kind === "list") return { kind: "listing", listing: { turns: answer.turns, undone: answer.undone } };
    if (answer?.kind === "nocheckout") return { kind: "unavailable", reason: "workspace" };
    if (answer?.kind === "missing") return { kind: "unavailable", reason: "ended" };
    return { kind: "unreachable" };
}

/** A computer's answer to a step, in this module's words. Pure. */
export function computerStep(answer: core.SnapshotAnswer | null): StepAnswer {
    switch (answer?.kind) {
        case "undone":
            return { kind: "done", result: { kind: "undone", id: answer.id } };
        case "restored":
        case "empty":
        case "stale":
        case "nocheckout":
        case "failed":
            return { kind: "done", result: { kind: answer.kind } };
        case "missing":
            return { kind: "unavailable", reason: "ended" };
        default:
            return { kind: "unreachable" };
    }
}

/** The session's newest turns and where an undo stands. */
export async function listSessionTurns(session: SessionView): Promise<TurnsAnswer> {
    const place = await reachable(session, false);
    if ("reason" in place) return { kind: "unavailable", reason: place.reason };
    if ("computer" in place) return computerTurns(await runComputerSnapshot(place.computer, { kind: "list" }));
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
    if ("computer" in place) {
        const to = input.to && snapshots.COMMIT_PATTERN.test(input.to) ? input.to : undefined;
        const action: core.SnapshotAction = input.direction === "undo" ? { kind: "undo", to } : { kind: "redo" };
        return computerStep(await runComputerSnapshot(place.computer, action));
    }
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
