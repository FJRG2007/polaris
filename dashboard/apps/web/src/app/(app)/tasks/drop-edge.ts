/**
 * Which side of a row a drop landed on.
 *
 * A target that always means "put it above me" lies to whoever dragged
 * downwards: the pointer is over the lower half of a row, the line is drawn
 * above it, and the card settles one place short of where it was let go - so
 * dragging something down by one position appears to do nothing at all. The
 * half of the row the pointer is in decides instead, which is what every list
 * that can be arranged by hand does, and the line is drawn on that same edge.
 *
 * Shared by every list in Tasks that can be reordered - the board, the list and
 * table views, subtasks, checklists and the space tree - so one gesture cannot
 * mean two different things depending on which screen it was made on.
 */

export type DropEdge = "before" | "after";

/** The half of `element` that `clientY` is in. */
export function dropEdge(clientY: number, element: Element): DropEdge {
    const box = element.getBoundingClientRect();
    return clientY < box.top + box.height / 2 ? "before" : "after";
}

/**
 * The neighbours a drop on `targetId` landed between, reported rather than an
 * index so the server computes the order key from what was actually on screen
 * and two people dragging at once cannot renumber each other's rows.
 *
 * The dragged row is taken out of the sequence first: it is leaving the place it
 * is in, so it is not a neighbour of anything.
 *
 * Null when the row landed on is not in the sequence - it is the dragged row
 * itself, or one that somebody else has since removed. That is not a pair of
 * empty neighbours: every server here reads two nulls as "no position given" and
 * puts the row at the end of its container, which would send a row released on
 * its own place to the bottom of the list. A drop that names no place is a drop
 * that moves nothing.
 */
export function neighbours(
    siblings: readonly { readonly id: string }[],
    targetId: string,
    dragged: string,
    edge: DropEdge
): { beforeId: string | null; afterId: string | null } | null {
    const without = siblings.filter((entry) => entry.id !== dragged);
    const index = without.findIndex((entry) => entry.id === targetId);
    if (index === -1) return null;
    return edge === "before"
        ? { beforeId: without[index - 1]?.id ?? null, afterId: targetId }
        : { beforeId: targetId, afterId: without[index + 1]?.id ?? null };
}
