"use client";

/**
 * What can be done with one row of a table, reached two ways: the three dots at
 * the end of the row and a right-click anywhere on it. Both draw the same list,
 * built once here, so the two can never offer different things. Lifted out of
 * the containers list so every table offers its actions the same way.
 */

import Link from "next/link";
import { Fragment, type ReactNode } from "react";
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
import { MoreHorizontal } from "lucide-react";

/** One option. A link when it opens a page, so it can be opened in a new tab. */
export interface RowAction {
    key: string;
    label: string;
    icon: ReactNode;
    href?: string;
    onSelect?: () => void;
    disabled?: boolean;
    danger?: boolean;
    /** Drawn after a separator: the options that change the row's subject. */
    manage?: boolean;
}

function Items({ actions, kind }: { actions: RowAction[]; kind: "dropdown" | "context" }) {
    const Item = kind === "dropdown" ? DropdownMenuItem : ContextMenuItem;
    const Separator = kind === "dropdown" ? DropdownMenuSeparator : ContextMenuSeparator;
    const firstManage = actions.findIndex((action) => action.manage);
    return (
        <>
            {actions.map((action, index) => (
                <Fragment key={action.key}>
                    {index === firstManage && index > 0 ? <Separator /> : null}
                    {action.href && !action.disabled ? (
                        <Item asChild>
                            <Link href={action.href}>
                                {action.icon}
                                {action.label}
                            </Link>
                        </Item>
                    ) : (
                        <Item
                            disabled={action.disabled}
                            variant={action.danger ? "danger" : "default"}
                            onSelect={action.onSelect}
                        >
                            {action.icon}
                            {action.label}
                        </Item>
                    )}
                </Fragment>
            ))}
        </>
    );
}

/** The three dots at the end of a row. */
export function RowActionsMenu({
    title,
    label,
    actions
}: {
    /** The row's name, heading the menu. */
    title: string;
    /** What the trigger is called to a screen reader. */
    label: string;
    actions: RowAction[];
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="icon" variant="ghost" aria-label={label} title={label}>
                    <MoreHorizontal className="size-4 shrink-0" />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
                <DropdownMenuLabel className="max-w-64 truncate">{title}</DropdownMenuLabel>
                <Items actions={actions} kind="dropdown" />
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** The same options on a right-click over `children`, which must be one element
 *  that takes a ref - a table row. */
export function RowContextMenu({
    title,
    actions,
    children
}: {
    title: string;
    actions: RowAction[];
    children: ReactNode;
}) {
    return (
        <ContextMenu>
            <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
            <ContextMenuContent className="min-w-44">
                <ContextMenuLabel className="max-w-64 truncate">{title}</ContextMenuLabel>
                <Items actions={actions} kind="context" />
            </ContextMenuContent>
        </ContextMenu>
    );
}
