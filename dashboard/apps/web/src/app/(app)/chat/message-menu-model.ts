/**
 * A message's actions as data, drawn twice: as the right-click menu with a
 * mouse (`MessageMenu`) and as the sheet that rises from the bottom on a touch
 * screen (`MessageSheet`).
 *
 * Both are drawn from the one list `MessageMenu` builds, so whatever decides
 * that an action is offered - who wrote it, what the reader may do, what was
 * pressed - decides it for both at once, and the two cannot drift apart.
 */

import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import type { DropdownMenuItem, DropdownMenuSeparator } from "@polaris/ui";

export interface MenuEntry {
    readonly key: string;
    readonly icon?: LucideIcon;
    readonly label: ReactNode;
    /** The full words, where the label may be cut short. */
    readonly title?: string;
    /** The keys that do the same, said on the menu only: a phone has no keyboard. */
    readonly hint?: ReactNode;
    /** A note at the end of the line: the time a reminder is for, a file's type. */
    readonly trailing?: ReactNode;
    readonly danger?: boolean;
    readonly disabled?: boolean;
    /** What it does. `shift` is whether Shift was held, which only a click knows. */
    readonly run?: (shift: boolean) => void;
    /** A download the route serves: a link rather than anything to run. */
    readonly link?: { readonly href: string; readonly download: string };
    /** A list of its own - a submenu on the menu, a second page in the sheet. */
    readonly sub?: readonly (readonly MenuEntry[])[];
}

/** The menu's own item and separator, for a section that draws itself. */
export interface MenuParts {
    readonly Item: typeof DropdownMenuItem;
    readonly Separator: typeof DropdownMenuSeparator;
}

/**
 * One group of actions: a run of items between two separators on the menu, one
 * rounded card in the sheet. `draw` is for a set that is already written as
 * menu items elsewhere (a picture's), handed the item of whichever surface it
 * is being drawn into.
 */
export interface MenuSection {
    readonly key: string;
    readonly entries?: readonly MenuEntry[];
    readonly draw?: (parts: MenuParts) => ReactNode;
}

export interface MenuReactions {
    readonly quick: readonly string[];
    readonly react: (emoji: string) => void;
    /** The full picker. */
    readonly more?: () => void;
}

export interface MenuModel {
    /** What the press was on - a link, a picture, a file - drawn first. */
    readonly target: readonly MenuSection[];
    readonly reactions: MenuReactions | null;
    /** The message's own groups, the heavy ones last. */
    readonly sections: readonly MenuSection[];
}

/** Every group that has something in it, in the order both surfaces draw them. */
export function filled(sections: readonly MenuSection[]): MenuSection[] {
    return sections.filter((section) => section.draw || (section.entries?.length ?? 0) > 0);
}
