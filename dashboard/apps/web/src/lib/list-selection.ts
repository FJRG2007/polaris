/**
 * Picking several rows out of a list, the way every file manager does it.
 *
 * A plain click selects one, ctrl (cmd on a Mac) adds or removes one, and shift
 * takes everything between the last row somebody touched and this one. Nobody is
 * taught those three - they are muscle memory from the desktop - which is exactly
 * why a list that gets them subtly wrong is worse than one with checkboxes.
 *
 * The anchor is the part that is easy to get wrong: shift extends from the last
 * row that was chosen deliberately, not from the last row the selection happens
 * to touch, so a shift-click after a shift-click grows and shrinks the same range
 * instead of leaving a trail behind it.
 *
 * Pure and free of React and the DOM: the maths is the part worth testing, and
 * every screen keeps its own state.
 */

/** The modifiers that decide what a click means. */
export interface SelectionModifiers {
    readonly shiftKey?: boolean;
    readonly ctrlKey?: boolean;
    readonly metaKey?: boolean;
}

/** Where the selection stands, and which row a shift extends from next. */
export interface SelectionState {
    readonly selected: Set<string>;
    readonly anchor: number | null;
}

/** Every key between two rows, in either direction, both ends included. */
export function rangeBetween(keys: readonly string[], from: number, to: number): Set<string> {
    const [low, high] = from < to ? [from, to] : [to, from];
    const picked = new Set<string>();
    for (let index = Math.max(0, low); index <= Math.min(keys.length - 1, high); index++) {
        const key = keys[index];
        if (key) picked.add(key);
    }
    return picked;
}

/** The same set with one key added or removed. */
export function toggled(selected: ReadonlySet<string>, key: string): Set<string> {
    const next = new Set(selected);
    if (!next.delete(key)) next.add(key);
    return next;
}

/**
 * What a click leaves behind.
 *
 * A shift-click keeps whatever was already selected outside the range only when
 * it was built with ctrl; on its own it replaces the selection, which is what
 * makes shift-clicking twice feel like dragging one range rather than painting.
 */
export function afterClick(
    current: ReadonlySet<string>,
    keys: readonly string[],
    index: number,
    anchor: number | null,
    modifiers: SelectionModifiers
): SelectionState {
    const key = keys[index];
    if (!key) return { selected: new Set(current), anchor };
    if (modifiers.shiftKey) return { selected: rangeBetween(keys, anchor ?? index, index), anchor: anchor ?? index };
    if (modifiers.ctrlKey || modifiers.metaKey) return { selected: toggled(current, key), anchor: index };
    return { selected: new Set([key]), anchor: index };
}

/**
 * What an arrow key leaves behind.
 *
 * `extend` is shift held down: the cursor moves and the range from the anchor
 * follows it, so shift+Down repeatedly grows one block. Without it the cursor
 * carries the selection with it, one row at a time.
 */
export function afterMove(
    current: ReadonlySet<string>,
    keys: readonly string[],
    cursor: number | null,
    anchor: number | null,
    delta: number,
    extend: boolean
): SelectionState & { cursor: number } {
    if (keys.length === 0) return { selected: new Set(current), anchor, cursor: 0 };
    const start = cursor ?? anchor ?? -1;
    const next = start < 0 ? (delta > 0 ? 0 : keys.length - 1) : clamp(start + delta, keys.length);
    if (extend) return { selected: rangeBetween(keys, anchor ?? next, next), anchor: anchor ?? next, cursor: next };
    const key = keys[next];
    return { selected: key ? new Set([key]) : new Set(), anchor: next, cursor: next };
}

function clamp(value: number, length: number): number {
    return Math.max(0, Math.min(length - 1, value));
}
