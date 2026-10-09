"use client";

/**
 * A column's heading: its name, the menu that sorts or hides it, the edge that
 * widens it, and the grip that moves it. The name column stays first and
 * cannot be hidden or moved.
 */

import { useCrmT } from "./i18n";
import { useState, type DragEvent } from "react";
import type { CrmObject, FieldDef } from "../model/objects";
import { ArrowDown, ArrowUp, ArrowDownUp, EyeOff, X } from "lucide-react";
import { COLUMN_WIDTH, sortable, type ViewColumn, type ViewSort } from "../model/views";
import {
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    ResizeHandle
} from "@polaris/ui";

/** The drag payload type a column heading carries, so a dropped file or link
 *  is never taken for a column. */
const COLUMN_DRAG = "application/x-polaris-crm-column";

export function HeaderCell({
    object,
    field,
    column,
    sort,
    sticky,
    onSort,
    onHide,
    onResize,
    onMove
}: {
    object: CrmObject;
    field: FieldDef;
    column: ViewColumn;
    sort: ViewSort | undefined;
    /** Drawn over the rows as they scroll sideways: the name column. */
    sticky?: string;
    onSort: (direction: "asc" | "desc" | null) => void;
    onHide: () => void;
    onResize: (width: number) => void;
    /** Put the dragged column before this one. */
    onMove: (dragged: string) => void;
}) {
    const t = useCrmT();
    const [over, setOver] = useState(false);
    const label = t(`fields.${object}.${field.key}` as Parameters<typeof t>[0]);
    const movable = !field.primary;
    const SortIcon = sort?.direction === "asc" ? ArrowUp : ArrowDown;

    const accepts = (event: DragEvent) => movable && event.dataTransfer.types.includes(COLUMN_DRAG);

    return (
        <th
            scope="col"
            style={{ width: column.width, left: sticky }}
            aria-sort={sort ? (sort.direction === "asc" ? "ascending" : "descending") : undefined}
            className={cn(
                "relative h-9 border-b border-r border-border bg-card p-0 text-left font-normal",
                sticky ? "sticky top-0 z-20" : "sticky top-0 z-10",
                over && "shadow-[inset_2px_0_0_hsl(var(--primary))]"
            )}
            onDragOver={(event) => {
                if (!accepts(event)) return;
                event.preventDefault();
                setOver(true);
            }}
            onDragLeave={() => setOver(false)}
            onDrop={(event) => {
                setOver(false);
                if (!accepts(event)) return;
                event.preventDefault();
                const dragged = event.dataTransfer.getData(COLUMN_DRAG);
                if (dragged && dragged !== column.key) onMove(dragged);
            }}
        >
            <DropdownMenu>
                <DropdownMenuTrigger asChild>
                    <button
                        type="button"
                        draggable={movable}
                        onDragStart={(event) => {
                            event.dataTransfer.setData(COLUMN_DRAG, column.key);
                            event.dataTransfer.effectAllowed = "move";
                        }}
                        className="flex h-9 w-full min-w-0 items-center gap-1.5 px-2.5 text-[0.75rem] font-medium text-muted-foreground hover:bg-card-hover hover:text-foreground"
                    >
                        <span className="truncate" title={label}>
                            {label}
                        </span>
                        {sort ? <SortIcon className="size-3.5 shrink-0 text-foreground" /> : null}
                    </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="w-48">
                    {sortable(field.kind) ? (
                        <>
                            <DropdownMenuItem onSelect={() => onSort("asc")}>
                                <ArrowUp className="size-3.5" />
                                {t("columns.sortAscending")}
                            </DropdownMenuItem>
                            <DropdownMenuItem onSelect={() => onSort("desc")}>
                                <ArrowDown className="size-3.5" />
                                {t("columns.sortDescending")}
                            </DropdownMenuItem>
                            {sort ? (
                                <DropdownMenuItem onSelect={() => onSort(null)}>
                                    <X className="size-3.5" />
                                    {t("columns.clearSort")}
                                </DropdownMenuItem>
                            ) : null}
                        </>
                    ) : (
                        <DropdownMenuItem disabled>
                            <ArrowDownUp className="size-3.5" />
                            {t("columns.notSortable")}
                        </DropdownMenuItem>
                    )}
                    {field.primary ? null : (
                        <>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem onSelect={onHide}>
                                <EyeOff className="size-3.5" />
                                {t("columns.hide")}
                            </DropdownMenuItem>
                        </>
                    )}
                </DropdownMenuContent>
            </DropdownMenu>
            <span className="absolute inset-y-0 -right-0.5 z-10 flex">
                <ResizeHandle
                    axis="x"
                    size={column.width}
                    min={COLUMN_WIDTH.min}
                    max={COLUMN_WIDTH.max}
                    onChange={onResize}
                    onReset={() => onResize(field.width)}
                    label={t("columns.width", { field: label })}
                    className="h-full"
                />
            </span>
        </th>
    );
}
