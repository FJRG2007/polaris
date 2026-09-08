/**
 * Whose version of a shape wins when two people drew on the same one.
 *
 * A drawing is not text, so the CRDT cannot merge inside a shape the way it
 * merges inside a paragraph: two people dragging one rectangle produce two
 * whole rectangles, and something has to choose. The rule every collaborative
 * canvas uses, Excalidraw's own included, is on the shape itself - each carries
 * a `version` that counts up and a `versionNonce` that breaks a tie - so the
 * choice is the same on every screen without anybody comparing clocks.
 *
 * Kept here, pure and away from the editor, because it is the one piece of a
 * canvas that is genuinely hard to get right and trivially easy to test. The
 * editor above it does no reasoning about versions at all.
 */

/** As much of a shape as the merge cares about. Everything else on it - the
 *  points, the colours, the text - travels along and is never inspected. */
export interface SceneElement {
    readonly id: string;
    readonly version?: number;
    readonly versionNonce?: number;
    readonly isDeleted?: boolean;
    readonly [key: string]: unknown;
}

/**
 * Which of two versions of one shape is the later.
 *
 * Higher version wins. Where they are equal - two people who both moved a shape
 * exactly once since they last spoke - the nonce decides, and the *lower* one
 * wins for the same reason Excalidraw picks it: any consistent rule works, and
 * being the same rule as theirs means a scene reconciled here and one reconciled
 * by their own code do not disagree.
 */
export function laterOf<T extends SceneElement>(left: T, right: T): T {
    const ours = left.version ?? 0;
    const theirs = right.version ?? 0;
    if (ours !== theirs) return ours > theirs ? left : right;
    const oursNonce = left.versionNonce ?? 0;
    const theirsNonce = right.versionNonce ?? 0;
    if (oursNonce !== theirsNonce) return oursNonce < theirsNonce ? left : right;
    return left;
}

/**
 * The scene as both sides should see it.
 *
 * `mine` is what this canvas has and `theirs` is what the shared document holds.
 * The order is `theirs` first, because that is the order a canvas draws in and a
 * shape that arrived from somebody else should keep the place they gave it
 * rather than jumping to the end of the list on every reconcile.
 *
 * A deleted shape is kept rather than dropped: a deletion IS a version of that
 * shape, and forgetting it is how a shape somebody else deleted comes back the
 * next time this screen sends its scene.
 */
export function reconcileScene<T extends SceneElement>(mine: readonly T[], theirs: readonly T[]): T[] {
    const held = new Map<string, T>();
    for (const element of theirs) held.set(element.id, element);
    for (const element of mine) {
        const other = held.get(element.id);
        held.set(element.id, other ? laterOf(element, other) : element);
    }

    const ordered: T[] = [];
    const seen = new Set<string>();
    for (const element of theirs) {
        const winner = held.get(element.id);
        if (!winner || seen.has(element.id)) continue;
        seen.add(element.id);
        ordered.push(winner);
    }
    // Anything this canvas has that the document has not seen yet, in the order
    // it was drawn in.
    for (const element of mine) {
        if (seen.has(element.id)) continue;
        seen.add(element.id);
        const winner = held.get(element.id);
        if (winner) ordered.push(winner);
    }
    return ordered;
}

/** Which of this canvas's shapes are worth sending: the ones the document does
 *  not hold, or holds an older version of. Sending the rest is bytes for
 *  nothing, and on a busy drawing that is the difference between a wire that
 *  keeps up and one that does not. */
export function changedElements<T extends SceneElement>(
    mine: readonly T[],
    theirs: ReadonlyMap<string, T>
): T[] {
    const changed: T[] = [];
    for (const element of mine) {
        const other = theirs.get(element.id);
        if (!other || laterOf(element, other) === element) {
            if (other && laterOf(element, other) === other) continue;
            if (other && element.version === other.version && element.versionNonce === other.versionNonce) {
                continue;
            }
            changed.push(element);
        }
    }
    return changed;
}
