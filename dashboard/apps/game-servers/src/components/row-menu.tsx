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

import type { ReactNode } from "react";
import { MoreHorizontal } from "lucide-react";
import {
    Button,
    ContextMenu,
    ContextMenuContent,
    ContextMenuItem,
    ContextMenuLabel,
    ContextMenuSeparator,
    ContextMenuTrigger,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger
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
          readonly onSelect: () => void;
      }
    /** A place to go rather than something to do - somebody's profile on the
     *  service the game signs them in with. It opens in its own tab, and carries
     *  the same two words every outward link here does. */
    | { readonly kind: "link"; readonly text: string; readonly icon?: ReactNode; readonly href: string };

/** The link, drawn inside whichever menu item wraps it. */
function OutwardLink({ href, icon, text }: { href: string; icon?: ReactNode; text: string }) {
    return (
        <a href={href} target="_blank" rel="noreferrer noopener">
            {icon}
            {text}
        </a>
    );
}

/** The `...` at the end of a row. */
export function RowMenuButton({ entries, label }: { entries: readonly RowMenuEntry[]; label: string }) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label={label} title="More">
                    <MoreHorizontal className="size-4" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
                {entries.map((entry, index) =>
                    entry.kind === "separator" ? (
                        <DropdownMenuSeparator key={index} />
                    ) : entry.kind === "label" ? (
                        <DropdownMenuLabel
                            key={index}
                            className={entry.muted ? "text-xs font-normal text-muted-foreground" : undefined}
                        >
                            {entry.text}
                        </DropdownMenuLabel>
                    ) : entry.kind === "link" ? (
                        <DropdownMenuItem key={index} asChild>
                            <OutwardLink href={entry.href} icon={entry.icon} text={entry.text} />
                        </DropdownMenuItem>
                    ) : (
                        <DropdownMenuItem
                            key={index}
                            disabled={entry.disabled}
                            className={entry.danger ? "text-danger" : undefined}
                            onSelect={entry.onSelect}
                        >
                            {entry.icon}
                            {entry.text}
                        </DropdownMenuItem>
                    )
                )}
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
                {entries.map((entry, index) =>
                    entry.kind === "separator" ? (
                        <ContextMenuSeparator key={index} />
                    ) : entry.kind === "label" ? (
                        <ContextMenuLabel
                            key={index}
                            className={entry.muted ? "text-xs font-normal text-muted-foreground" : undefined}
                        >
                            {entry.text}
                        </ContextMenuLabel>
                    ) : entry.kind === "link" ? (
                        <ContextMenuItem key={index} asChild>
                            <OutwardLink href={entry.href} icon={entry.icon} text={entry.text} />
                        </ContextMenuItem>
                    ) : (
                        <ContextMenuItem
                            key={index}
                            disabled={entry.disabled}
                            className={entry.danger ? "text-danger" : undefined}
                            onSelect={entry.onSelect}
                        >
                            {entry.icon}
                            {entry.text}
                        </ContextMenuItem>
                    )
                )}
            </ContextMenuContent>
        </ContextMenu>
    );
}
