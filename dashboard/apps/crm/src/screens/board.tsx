"use client";

/**
 * A list as a board: one column per choice of a field (an opportunity's stage),
 * a card per record. A card is dragged to another column, or to another place
 * in its own when the board is not sorted; its menu does the same from the
 * keyboard. A new record is typed at the top of a column and starts with that
 * column's choice.
 *
 * What it changes it hands up: the screen applies it at once and undoes it if
 * the server refuses.
 */

import { useCrmT } from "./i18n";
import { cn } from "@polaris/ui";
import { editorFor } from "./cell-editors";
import type { RowGroup } from "./use-groups";
import type { ViewColumn } from "../model/views";
import { useState, type DragEvent } from "react";
import type { InputValue } from "../model/values";
import { CellDisplay, optionDot } from "./cell-display";
import { ArrowRightLeft, Check, Plus } from "lucide-react";
import {
    Button,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuTrigger
} from "@polaris/ui";
import {
    fieldOf,
    isEmptyValue,
    primaryField,
    recordName,
    type CrmObject,
    type CrmRecord,
    type FieldDef
} from "../model/objects";

/** The drag payload type a card carries, so a dropped file or link is never
 *  taken for a card. */
const CARD_DRAG = "application/x-polaris-crm-card";

/** The most fields a card shows under its name. */
const CARD_FIELDS = 5;

export interface BoardProps {
    readonly object: CrmObject;
    /** The field the columns are the choices of. */
    readonly field: FieldDef;
    readonly groups: readonly RowGroup[];
    /** The view's visible columns: the fields a card shows, in order. */
    readonly columns: readonly ViewColumn[];
    readonly canEdit: boolean;
    /** Cards keep the sorted order, so a drop only changes the column. */
    readonly sorted: boolean;
    readonly loadingGroup: string | null;
    readonly onLoadMore: (value: string) => void;
    /** A card dropped in a column, before the card with `beforeId` (null: at
     *  the end). */
    readonly onMove: (record: CrmRecord, value: string, beforeId: string | null) => void;
    readonly onCreate: (value: string, name: InputValue) => void;
}

export function Board(props: BoardProps) {
    const { object, field, groups } = props;
    const t = useCrmT();
    const [dragging, setDragging] = useState<string | null>(null);
    const [target, setTarget] = useState<{ value: string; beforeId: string | null } | null>(null);
    const [drafting, setDrafting] = useState<string | null>(null);
    const primary = primaryField(object);
    const DraftEditor = editorFor(primary);
    const shown = props.columns
        .map((column) => fieldOf(object, column.key))
        .filter((one): one is FieldDef => Boolean(one) && !one!.primary && one!.key !== field.key)
        .slice(0, CARD_FIELDS);
    const label = (value: string) =>
        t(`options.${object}.${field.key}.${value}` as Parameters<typeof t>[0]);
    const byId = new Map(groups.flatMap((group) => group.rows).map((row) => [row.id, row]));

    const accepts = (event: DragEvent) =>
        props.canEdit && event.dataTransfer.types.includes(CARD_DRAG);

    /** Where in a column a card would land: before the first card whose middle
     *  is below the pointer. */
    const placeAt = (event: DragEvent<HTMLElement>): string | null => {
        if (props.sorted) return null;
        const cards = [...event.currentTarget.querySelectorAll<HTMLElement>("[data-card]")];
        for (const card of cards) {
            const box = card.getBoundingClientRect();
            if (event.clientY < box.top + box.height / 2) return card.dataset.card ?? null;
        }
        return null;
    };

    const drop = (record: CrmRecord, value: string, beforeId: string | null) => {
        if (beforeId === record.id) return;
        const group = groups.find((one) => one.value === value);
        const index = group?.rows.findIndex((row) => row.id === record.id) ?? -1;
        // Dropped where it already is: in its own column, before the card that
        // already follows it, or at the end it already is at.
        if (index >= 0 && group) {
            const next = group.rows[index + 1]?.id ?? null;
            if (props.sorted || next === beforeId) return;
        }
        props.onMove(record, value, props.sorted ? null : beforeId);
    };

    return (
        <div
            className="flex min-h-0 flex-1 gap-3 overflow-x-auto overscroll-x-contain pb-1"
            aria-label={t("board.label", { field: t(`fields.${object}.${field.key}` as Parameters<typeof t>[0]) })}
            role="region"
        >
            {groups.map((group) => {
                const over = target?.value === group.value;
                return (
                    <section
                        key={group.value}
                        aria-label={label(group.value)}
                        className={cn(
                            "flex min-h-0 w-[17rem] shrink-0 flex-col rounded-lg border border-border bg-muted/40",
                            over && "border-primary"
                        )}
                    >
                        <header className="flex h-10 shrink-0 items-center gap-2 px-3">
                            <span
                                className={cn(
                                    "size-2 shrink-0 rounded-full",
                                    optionDot(field, group.value)
                                )}
                            />
                            <h2
                                className="min-w-0 truncate text-[0.8125rem] font-medium"
                                title={label(group.value)}
                            >
                                {label(group.value)}
                            </h2>
                            <span className="text-[0.75rem] tabular-nums text-muted-foreground">
                                {group.total}
                            </span>
                            {props.canEdit ? (
                                <button
                                    type="button"
                                    className="ml-auto grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-card-hover hover:text-foreground"
                                    aria-label={t("board.add", { column: label(group.value) })}
                                    title={t("board.add", { column: label(group.value) })}
                                    onClick={() => setDrafting(group.value)}
                                >
                                    <Plus className="size-4" />
                                </button>
                            ) : null}
                        </header>
                        <div
                            className="flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto overscroll-contain px-2 pb-2"
                            onDragOver={(event) => {
                                if (!accepts(event)) return;
                                event.preventDefault();
                                event.dataTransfer.dropEffect = "move";
                                const beforeId = placeAt(event);
                                if (target?.value !== group.value || target.beforeId !== beforeId) {
                                    setTarget({ value: group.value, beforeId });
                                }
                            }}
                            onDragLeave={(event) => {
                                if (!event.currentTarget.contains(event.relatedTarget as Node)) {
                                    setTarget(null);
                                }
                            }}
                            onDrop={(event) => {
                                setTarget(null);
                                if (!accepts(event)) return;
                                event.preventDefault();
                                const record = byId.get(event.dataTransfer.getData(CARD_DRAG));
                                if (record) drop(record, group.value, placeAt(event));
                            }}
                        >
                            {drafting === group.value && DraftEditor ? (
                                <div className="relative h-9 shrink-0 rounded-md border border-border bg-card">
                                    <DraftEditor
                                        field={primary}
                                        value={undefined}
                                        onCommit={(name) => {
                                            setDrafting(null);
                                            props.onCreate(group.value, name);
                                        }}
                                        onCancel={() => setDrafting(null)}
                                    />
                                </div>
                            ) : null}
                            {group.rows.map((record) => {
                                const pending = record.id.startsWith("draft:");
                                const name = recordName(object, record);
                                return (
                                    <article
                                        key={record.id}
                                        data-card={record.id}
                                        draggable={props.canEdit && !pending}
                                        aria-label={name}
                                        onDragStart={(event) => {
                                            event.dataTransfer.setData(CARD_DRAG, record.id);
                                            event.dataTransfer.effectAllowed = "move";
                                            setDragging(record.id);
                                        }}
                                        onDragEnd={() => {
                                            setDragging(null);
                                            setTarget(null);
                                        }}
                                        className={cn(
                                            "group/card relative flex shrink-0 flex-col gap-1.5 rounded-md border border-border bg-card p-2.5 shadow-sm",
                                            props.canEdit && !pending && "cursor-grab active:cursor-grabbing",
                                            dragging === record.id && "opacity-50",
                                            pending && "pointer-events-none opacity-60",
                                            over &&
                                                target?.beforeId === record.id &&
                                                "shadow-[0_-2px_0_hsl(var(--primary))]"
                                        )}
                                    >
                                        <div className="flex min-w-0 items-start gap-2">
                                            <span
                                                className="min-w-0 flex-1 truncate text-[0.8125rem] font-medium"
                                                title={name}
                                            >
                                                {name}
                                            </span>
                                            {props.canEdit && !pending ? (
                                                <MoveMenu
                                                    label={label}
                                                    field={field}
                                                    current={group.value}
                                                    name={name}
                                                    onMove={(value) =>
                                                        props.onMove(
                                                            record,
                                                            value,
                                                            // The top of the column it goes to.
                                                            groups.find((one) => one.value === value)
                                                                ?.rows[0]?.id ?? null
                                                        )
                                                    }
                                                />
                                            ) : null}
                                        </div>
                                        {shown
                                            .filter((one) => {
                                                const value = record.values[one.key];
                                                return one.kind === "boolean" ? value === true : !isEmptyValue(value);
                                            })
                                            .map((one) => (
                                                <div
                                                    key={one.key}
                                                    className="flex min-w-0 items-center gap-2 text-[0.75rem]"
                                                >
                                                    <span className="w-24 shrink-0 truncate text-muted-foreground">
                                                        {t(`fields.${object}.${one.key}` as Parameters<typeof t>[0])}
                                                    </span>
                                                    <span className="flex min-w-0 flex-1 items-center">
                                                        <CellDisplay
                                                            object={object}
                                                            field={one}
                                                            value={record.values[one.key]}
                                                        />
                                                    </span>
                                                </div>
                                            ))}
                                    </article>
                                );
                            })}
                            {over && target?.beforeId === null ? (
                                <span aria-hidden className="h-0.5 shrink-0 rounded bg-primary" />
                            ) : null}
                            {group.rows.length < group.total ? (
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    className="shrink-0"
                                    disabled={props.loadingGroup !== null}
                                    onClick={() => props.onLoadMore(group.value)}
                                >
                                    {props.loadingGroup === group.value
                                        ? t("list.loadingMore")
                                        : t("board.more", { count: group.total - group.rows.length })}
                                </Button>
                            ) : null}
                        </div>
                    </section>
                );
            })}
        </div>
    );
}

/** A card's own way to another column, for a keyboard or a touch screen. */
function MoveMenu({
    label,
    field,
    current,
    name,
    onMove
}: {
    label: (value: string) => string;
    field: FieldDef;
    current: string;
    name: string;
    onMove: (value: string) => void;
}) {
    const t = useCrmT();
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="grid size-6 shrink-0 place-items-center rounded text-muted-foreground opacity-0 hover:bg-card-hover hover:text-foreground focus-visible:opacity-100 group-hover/card:opacity-100 data-[state=open]:opacity-100 [@media(hover:none)]:opacity-100"
                    aria-label={t("board.moveCard", { name })}
                    title={t("board.moveCard", { name })}
                >
                    <ArrowRightLeft className="size-3.5" />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel>{t("board.moveTo")}</DropdownMenuLabel>
                {(field.options ?? []).map((option) => (
                    <DropdownMenuItem
                        key={option}
                        disabled={option === current}
                        onSelect={() => onMove(option)}
                        className="gap-2"
                    >
                        <span className={cn("size-2 shrink-0 rounded-full", optionDot(field, option))} />
                        <span className="min-w-0 flex-1 truncate">{label(option)}</span>
                        {option === current ? <Check className="size-3.5 shrink-0" /> : null}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
