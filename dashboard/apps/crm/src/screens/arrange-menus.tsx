"use client";

/**
 * How a view orders and splits its records: up to three sorts, each on its own
 * field and direction, the first deciding most; and the field a table's rows
 * are grouped by, or a board's columns are drawn from.
 */

import { useCrmT } from "./i18n";
import { FIELDS, type CrmObject, type FieldDef } from "../model/objects";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, Rows3, X } from "lucide-react";
import { MAX_SORTS, groupFields, sortable, type ViewSort } from "../model/views";
import {
    Button,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuSub,
    DropdownMenuSubContent,
    DropdownMenuSubTrigger,
    DropdownMenuTrigger
} from "@polaris/ui";

function useFieldName(object: CrmObject) {
    const t = useCrmT();
    return (key: string) => t(`fields.${object}.${key}` as Parameters<typeof t>[0]);
}

export function SortMenu({
    object,
    sorts,
    onChange,
    disabled
}: {
    object: CrmObject;
    sorts: readonly ViewSort[];
    onChange: (sorts: ViewSort[]) => void;
    disabled?: boolean;
}) {
    const t = useCrmT();
    const name = useFieldName(object);
    const full = sorts.length >= MAX_SORTS;
    const free = FIELDS[object].filter(
        (field) => sortable(field.kind) && !sorts.some((sort) => sort.key === field.key)
    );
    const set = (index: number, next: ViewSort | null) =>
        onChange(sorts.flatMap((sort, at) => (at === index ? (next ? [next] : []) : [sort])));

    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    className={cn(sorts.length > 0 && "border-primary text-foreground")}
                >
                    <ArrowUpDown className="size-4" />
                    {t("sorts.button")}
                    {sorts.length > 0 ? (
                        <span className="rounded bg-primary/10 px-1 text-[0.75rem] tabular-nums text-primary">
                            {sorts.length}
                        </span>
                    ) : null}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
                {sorts.length > 0 ? (
                    <>
                        <DropdownMenuLabel>{t("sorts.current")}</DropdownMenuLabel>
                        {sorts.map((sort, index) => {
                            const Arrow = sort.direction === "asc" ? ArrowUp : ArrowDown;
                            return (
                                <DropdownMenuSub key={sort.key}>
                                    <DropdownMenuSubTrigger className="gap-2">
                                        <span className="w-4 shrink-0 text-[0.75rem] tabular-nums text-muted-foreground">
                                            {index + 1}
                                        </span>
                                        <span className="min-w-0 flex-1 truncate">
                                            {name(sort.key)}
                                        </span>
                                        <Arrow
                                            className="size-3.5 shrink-0"
                                            aria-label={t(`sorts.${sort.direction}`)}
                                        />
                                    </DropdownMenuSubTrigger>
                                    <DropdownMenuSubContent className="w-48">
                                        <DropdownMenuItem
                                            onSelect={() =>
                                                set(index, { ...sort, direction: "asc" })
                                            }
                                        >
                                            <ArrowUp className="size-3.5" />
                                            <span className="flex-1">
                                                {t("columns.sortAscending")}
                                            </span>
                                            {sort.direction === "asc" ? (
                                                <Check className="size-3.5" />
                                            ) : null}
                                        </DropdownMenuItem>
                                        <DropdownMenuItem
                                            onSelect={() =>
                                                set(index, { ...sort, direction: "desc" })
                                            }
                                        >
                                            <ArrowDown className="size-3.5" />
                                            <span className="flex-1">
                                                {t("columns.sortDescending")}
                                            </span>
                                            {sort.direction === "desc" ? (
                                                <Check className="size-3.5" />
                                            ) : null}
                                        </DropdownMenuItem>
                                        <DropdownMenuSeparator />
                                        <DropdownMenuItem onSelect={() => set(index, null)}>
                                            <X className="size-3.5" />
                                            {t("columns.clearSort")}
                                        </DropdownMenuItem>
                                    </DropdownMenuSubContent>
                                </DropdownMenuSub>
                            );
                        })}
                        <DropdownMenuSeparator />
                    </>
                ) : null}
                <DropdownMenuLabel>
                    {full ? t("sorts.full", { max: MAX_SORTS }) : t("sorts.add")}
                </DropdownMenuLabel>
                {free.map((field) => (
                    <DropdownMenuItem
                        key={field.key}
                        disabled={full}
                        onSelect={() => onChange([...sorts, { key: field.key, direction: "asc" }])}
                    >
                        <span className="truncate">{name(field.key)}</span>
                    </DropdownMenuItem>
                ))}
                {sorts.length > 0 ? (
                    <>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem onSelect={() => onChange([])}>
                            <X className="size-3.5" />
                            {t("sorts.clear")}
                        </DropdownMenuItem>
                    </>
                ) : null}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/**
 * The field a table is grouped by (or nothing), or the one a board's columns
 * come from. A kind of record with no field to group by gets the button
 * disabled, saying why.
 */
export function GroupMenu({
    object,
    value,
    onChange,
    board,
    disabled
}: {
    object: CrmObject;
    /** The chosen field; null is no grouping. */
    value: FieldDef | null;
    onChange: (key: string | null) => void;
    /** A board's columns: a field is always chosen. */
    board: boolean;
    disabled?: boolean;
}) {
    const t = useCrmT();
    const name = useFieldName(object);
    const fields = groupFields(object);
    const none = fields.length === 0;
    const label = value
        ? t(board ? "groups.columnsField" : "groups.buttonField", { field: name(value.key) })
        : t("groups.button");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="outline"
                    size="sm"
                    disabled={disabled || none}
                    title={none ? t("groups.unavailable") : undefined}
                    className={cn(!board && value && "border-primary text-foreground")}
                >
                    <Rows3 className="size-4" />
                    <span className="truncate" title={label}>
                        {label}
                    </span>
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuLabel>
                    {board ? t("groups.columnsBy") : t("groups.by")}
                </DropdownMenuLabel>
                {board ? null : (
                    <DropdownMenuItem onSelect={() => onChange(null)} className="gap-2">
                        <span className="flex-1">{t("groups.none")}</span>
                        {value === null ? <Check className="size-3.5" /> : null}
                    </DropdownMenuItem>
                )}
                {fields.map((field) => (
                    <DropdownMenuItem
                        key={field.key}
                        onSelect={() => onChange(field.key)}
                        className="gap-2"
                    >
                        <span className="min-w-0 flex-1 truncate">{name(field.key)}</span>
                        {value?.key === field.key ? <Check className="size-3.5" /> : null}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
