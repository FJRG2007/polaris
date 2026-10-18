"use client";

/**
 * What can be done to one row, written once and offered twice.
 *
 * A player row carries its verbs in two places: the icons at its right end and
 * the `...` beside them. Right-clicking the row offered neither, which is the
 * first thing anybody tries on a table of names - every file manager and every
 * game panel answers that press, and a table that does not reads as a list you
 * can only look at.
 *
 * The menu is therefore a list of entries rather than a tree of components, and
 * the two renderers below draw the same list: `RowMenuButton` as the `...`, and
 * `RowContextMenu` as the menu the right button opens. They cannot drift, which
 * is the whole reason for the shape - the alternative was the same twenty items
 * written out a second time, and the second copy going stale the first time
 * anybody added a verb.
 */

import { forwardRef } from "react";
import type { AnchorHTMLAttributes, ReactNode } from "react";
import { useGameText } from "../screens/game-text";
import { Check, MoreHorizontal } from "lucide-react";
import {
    Button,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuSub,
    ContextMenuSubContent,
    ContextMenuSubTrigger,
    ContextMenuTrigger,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger,
    MenuShortcut
} from "@polaris/ui";

/** One line of a row's menu. */
export type RowMenuEntry =
    | { readonly kind: "label"; readonly text: string; readonly muted?: boolean }
    | { readonly kind: "separator" }
    | {
          readonly kind: "item";
          readonly text: string;
          readonly icon?: ReactNode;
          readonly disabled?: boolean;
          /** Drawn in the danger tone: killing, banning, taking access away. */
          readonly danger?: boolean;
          /** One of a set where exactly one holds - the game mode somebody is
           *  in. Drawn with a tick, and read out as the one chosen. */
          readonly checked?: boolean;
          /** The key the screen binds to the same verb, written as `Mod+A` and
           *  printed for the platform reading it. Only for a key that is bound. */
          readonly shortcut?: string;
          readonly onSelect: () => void;
      }
    /** A place to go rather than something to do - somebody's profile on the
     *  service the game signs them in with. It opens in its own tab, and carries
     *  the same two words every outward link here does. */
    | {
          readonly kind: "link";
          readonly text: string;
          readonly icon?: ReactNode;
          readonly href: string;
      }
    /** A verb with a choice behind it - which game mode, which file format. One
     *  line in the menu however many choices there are, so the menu does not
     *  grow with them. */
    | {
          readonly kind: "submenu";
          readonly text: string;
          readonly icon?: ReactNode;
          readonly disabled?: boolean;
          readonly entries: readonly RowMenuEntry[];
      };

type ItemEntry = Extract<RowMenuEntry, { kind: "item" }>;

/**
 * The link, drawn inside whichever menu item wraps it.
 *
 * The item renders it `asChild`, which hands the item's own class, ref and
 * keyboard handling to this element - so they have to reach the `<a>`. Dropped,
 * the link was drawn as bare text at the page's size beside items drawn at the
 * menu's.
 */
const OutwardLink = forwardRef<
    HTMLAnchorElement,
    AnchorHTMLAttributes<HTMLAnchorElement> & { href: string; icon?: ReactNode; text: string }
>(({ href, icon, text, ...props }, ref) => (
    <a {...props} ref={ref} href={href} target="_blank" rel="noreferrer noopener">
        {icon}
        {text}
    </a>
));
OutwardLink.displayName = "OutwardLink";

/** What sits in an item's icon slot: a tick for the chosen one of a set, and an
 *  empty slot of the same width for the others so their words line up. */
function itemIcon(entry: ItemEntry): ReactNode {
    if (entry.checked === undefined) return entry.icon;
    return entry.checked ? (
        <Check className="size-4 shrink-0" aria-hidden />
    ) : (
        <span className="size-4 shrink-0" aria-hidden />
    );
}

/** The ARIA a ticked item carries, so a screen reader hears which one holds. */
function itemRole(entry: ItemEntry) {
    return entry.checked === undefined
        ? {}
        : { role: "menuitemradio" as const, "aria-checked": entry.checked };
}

const MUTED_LABEL = "text-xs font-normal text-muted-foreground";

function DropdownEntries({ entries }: { entries: readonly RowMenuEntry[] }) {
    return entries.map((entry, index) =>
        entry.kind === "separator" ? (
            <DropdownMenuSeparator key={index} />
        ) : entry.kind === "label" ? (
            <DropdownMenuLabel key={index} className={entry.muted ? MUTED_LABEL : undefined}>
                {entry.text}
            </DropdownMenuLabel>
        ) : entry.kind === "link" ? (
            <DropdownMenuItem key={index} asChild>
                <OutwardLink href={entry.href} icon={entry.icon} text={entry.text} />
            </DropdownMenuItem>
        ) : entry.kind === "submenu" ? (
            <DropdownMenuSub key={index}>
                <DropdownMenuSubTrigger disabled={entry.disabled}>
                    {entry.icon}
                    {entry.text}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                    <DropdownEntries entries={entry.entries} />
                </DropdownMenuSubContent>
            </DropdownMenuSub>
        ) : (
            <DropdownMenuItem
                key={index}
                {...itemRole(entry)}
                disabled={entry.disabled}
                className={entry.danger ? "text-danger" : undefined}
                onSelect={entry.onSelect}
            >
                {itemIcon(entry)}
                {entry.text}
                {entry.shortcut ? <MenuShortcut keys={entry.shortcut} /> : null}
            </DropdownMenuItem>
        )
    );
}

function ContextEntries({ entries }: { entries: readonly RowMenuEntry[] }) {
    return entries.map((entry, index) =>
        entry.kind === "separator" ? (
            <ContextMenuSeparator key={index} />
        ) : entry.kind === "label" ? (
            <ContextMenuLabel key={index} className={entry.muted ? MUTED_LABEL : undefined}>
                {entry.text}
            </ContextMenuLabel>
        ) : entry.kind === "link" ? (
            <ContextMenuItem key={index} asChild>
                <OutwardLink href={entry.href} icon={entry.icon} text={entry.text} />
            </ContextMenuItem>
        ) : entry.kind === "submenu" ? (
            <ContextMenuSub key={index}>
                <ContextMenuSubTrigger disabled={entry.disabled}>
                    {entry.icon}
                    {entry.text}
                </ContextMenuSubTrigger>
                <ContextMenuSubContent>
                    <ContextEntries entries={entry.entries} />
                </ContextMenuSubContent>
            </ContextMenuSub>
        ) : (
            <ContextMenuItem
                key={index}
                {...itemRole(entry)}
                disabled={entry.disabled}
                className={entry.danger ? "text-danger" : undefined}
                onSelect={entry.onSelect}
            >
                {itemIcon(entry)}
                {entry.text}
                {entry.shortcut ? <MenuShortcut keys={entry.shortcut} /> : null}
            </ContextMenuItem>
        )
    );
}

/** The `...` at the end of a row. */
export function RowMenuButton({
    entries,
    label
}: {
    entries: readonly RowMenuEntry[];
    label: string;
}) {
    const t = useGameText("games");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label={label} title={t("rowMenu.more")}>
                    <MoreHorizontal className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                <DropdownEntries entries={entries} />
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * The same menu, on the right button, around whatever the row is.
 *
 * `asChild` rather than a wrapper element: the child here is a `<tr>`, and a
 * `<div>` put around one is a table cell the browser moves out of the table.
 */
export function RowContextMenu({
    entries,
    children
}: {
    entries: readonly RowMenuEntry[];
    children: ReactNode;
}) {
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent>
                <ContextEntries entries={entries} />
            </ContextMenuContent>
        </ContextMenu>
    );
}
