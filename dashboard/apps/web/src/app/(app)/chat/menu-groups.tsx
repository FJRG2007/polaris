"use client";

/**
 * A menu drawn as groups with a line between each.
 *
 * Which items a reader is offered depends on what they may do, so any one group
 * can come out empty. Writing the separators by hand next to conditional items
 * is how a menu ends up opening on a line, closing on one, or showing two in a
 * row. Here the groups are worked out first and the lines are only ever put
 * between two that have something in them.
 */

import { createElement, Fragment, type ComponentType, type ReactNode } from "react";

/** One group's items; `false`, `null` and `undefined` are the ones not offered. */
export type MenuGroup = readonly (ReactNode | false | null | undefined)[];

/** The groups that have something in them, with `Separator` between each. */
export function joinMenuGroups(
    groups: readonly MenuGroup[],
    Separator: ComponentType
): ReactNode[] {
    const filled = groups
        .map((group) => group.filter((item) => item !== false && item != null))
        .filter((group) => group.length > 0);
    return filled.flatMap((group, index) => [
        ...(index > 0 ? [createElement(Separator, { key: `separator-${index}` })] : []),
        createElement(Fragment, { key: `group-${index}` }, ...group)
    ]);
}
