/**
 * What a reorder inside a task looks like before the server has agreed to it.
 *
 * Checklists, the steps in them and a task's dependencies are all moved the same
 * way a task is: the drop names the two rows it landed between, the server works
 * out the key, and the screen shows the new order on the release rather than on
 * the round trip. These are the pure halves of that - where a row lands, and the
 * neighbours a one-place move by keyboard names - so they can be asserted.
 */

import * as core from "@polaris/core";
import { neighbours } from "./drop-edge";
import type { ChecklistView, DependencyView } from "@/lib/tasks/task-service";

export type DropPosition = { beforeId: string | null; afterId: string | null };

/** `rows` in the order a drop between `position`'s neighbours leaves them. */
export function placeRow<Row extends { readonly id: string }>(
    rows: readonly Row[],
    movedId: string,
    position: DropPosition
): Row[] {
    const byId = new Map(rows.map((row) => [row.id, row]));
    return core
        .arrangeAround(
            rows.map((row) => row.id),
            movedId,
            position
        )
        .map((id) => byId.get(id))
        .filter((row): row is Row => row !== undefined);
}

/** Whether a move leaves the rows exactly where they were, which is no move and
 *  no write. */
export function samePlace(
    rows: readonly { readonly id: string }[],
    next: readonly { readonly id: string }[]
): boolean {
    return rows.length === next.length && rows.every((row, index) => row.id === next[index]?.id);
}

/**
 * The neighbours a move of one place up (-1) or down (1) names, for the reader
 * using the buttons instead of a drag. Null at either end of the list, where
 * there is nowhere to go.
 */
export function shiftPosition(
    rows: readonly { readonly id: string }[],
    movedId: string,
    delta: -1 | 1
): DropPosition | null {
    const index = rows.findIndex((row) => row.id === movedId);
    const target = index === -1 ? undefined : rows[index + delta];
    if (!target) return null;
    return neighbours(rows, target.id, movedId, delta === -1 ? "before" : "after");
}

/**
 * The checklists after a step was moved, into its own checklist or another one
 * on the same task. A step that is not on any of them leaves them as they were.
 */
export function placeStep(
    checklists: readonly ChecklistView[],
    itemId: string,
    destinationId: string,
    position: DropPosition
): ChecklistView[] {
    const item = checklists.flatMap((checklist) => checklist.items).find((step) => step.id === itemId);
    if (!item || !checklists.some((checklist) => checklist.id === destinationId))
        return [...checklists];
    return checklists.map((checklist) => {
        const without = checklist.items.filter((step) => step.id !== itemId);
        if (checklist.id !== destinationId) return { ...checklist, items: without };
        return { ...checklist, items: placeRow([...without, item], itemId, position) };
    });
}

/** The dependencies after one was moved inside its own list. The other list,
 *  which keeps an order of its own, is left exactly as it was. */
export function placeDependency(
    dependencies: readonly DependencyView[],
    dependencyId: string,
    direction: core.DependencyDirection,
    position: DropPosition
): DependencyView[] {
    const list = dependencies.filter((edge) => edge.direction === direction);
    const others = dependencies.filter((edge) => edge.direction !== direction);
    return [...placeRow(list, dependencyId, position), ...others];
}
