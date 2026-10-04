/**
 * The bookkeeping behind the name-clash dialog, kept apart from it so the rules
 * can be tested without a screen: what deciding one clash does to the rest, and
 * which choices a clash may be offered.
 */

import type { ClashView, ConflictChoice } from "@/lib/drive/conflict-types";

/** Where the dialog is: the clashes still open and what was decided so far. */
export interface ConflictQueue {
    readonly pending: readonly ClashView[];
    readonly decided: ReadonlyMap<string, ConflictChoice>;
}

/** A queue with every clash still to decide. */
export function startQueue(clashes: readonly ClashView[]): ConflictQueue {
    return { pending: clashes, decided: new Map() };
}

/**
 * The choices one clash may be given. "Replace" is for a file onto a file and
 * "Merge" for a folder onto a folder, each only when the server said the
 * person may change what is there; "Skip" only when something else is still
 * arriving with it, since skipping the only item is what Cancel already does.
 */
export function choicesFor(clash: ClashView, batch: boolean): ConflictChoice[] {
    const choices: ConflictChoice[] = [];
    if (clash.canReplace) choices.push(clash.incomingKind === "dir" ? "merge" : "replace");
    choices.push("keepBoth");
    if (batch) choices.push("skip");
    return choices;
}

/**
 * Decide the clash at the head of the queue. With `toAll`, the same choice is
 * given to every other open clash that may take it; one that may not (a
 * "Replace" for a file the person cannot change) stays open to be asked about
 * on its own rather than being quietly given something else.
 */
export function decide(
    queue: ConflictQueue,
    choice: ConflictChoice,
    toAll: boolean,
    batch: boolean
): ConflictQueue {
    const [head, ...rest] = queue.pending;
    if (!head) return queue;
    const decided = new Map(queue.decided);
    decided.set(head.path, choice);
    if (!toAll) return { pending: rest, decided };
    const open: ClashView[] = [];
    for (const clash of rest) {
        const allowed = choicesFor(clash, batch);
        // "Replace" for files and "Merge" for folders are one answer: "let what
        // arrives take the place of what is there".
        const fitted =
            choice === "replace" || choice === "merge"
                ? clash.incomingKind === "dir"
                    ? "merge"
                    : "replace"
                : choice;
        if (allowed.includes(fitted)) decided.set(clash.path, fitted);
        else open.push(clash);
    }
    return { pending: open, decided };
}
