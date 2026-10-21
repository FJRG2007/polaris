/**
 * What a right-click in the listing acts on, and which events the listing may
 * answer at all.
 *
 * Its own module, with nothing to render, so the rules can be held to account
 * without drawing a file list.
 */

/**
 * The whole selection when the clicked item is part of it, otherwise that item
 * alone. Every file manager works this way, and it is the only rule under which
 * an action never quietly reaches something the pointer was never on.
 */
export function menuTargets<T extends { path: string }>(
    selected: ReadonlySet<string>,
    selectedEntries: readonly T[],
    entry: T
): T[] {
    return selected.has(entry.path) && selectedEntries.length > 1 ? [...selectedEntries] : [entry];
}

/**
 * Whether an event reached a listing handler from somewhere the listing does not
 * hold on the page.
 *
 * React delivers an event along its own tree, not the page's, so a press inside
 * a row's right-click menu - drawn in a portal at the foot of the page - still
 * arrives at the listing's handlers as if it had happened over the list. The
 * list's mousedown started a marquee on it, which emptied the selection between
 * the press on "Move to..." and its release: the menu redrew for one item, the
 * entries under the pointer changed, and the release chose whatever was now
 * there. The keyboard had the same hole - Enter on a menu item also opened the
 * selected file.
 */
export function fromOutside(event: { currentTarget: EventTarget; target: EventTarget }): boolean {
    const own = event.currentTarget as Node;
    const target = event.target as Node | null;
    return !target || typeof own.contains !== "function" || !own.contains(target);
}
