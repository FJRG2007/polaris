"use client";

/**
 * The table of one list. Headings and totals stay put while the rows scroll
 * under them, and the box and name columns stay put while the rest scrolls
 * sideways. A press on a cell edits it in place, a tick box chooses the row
 * (Shift chooses a run of them), and reaching the bottom asks for the next page.
 * Grouped by a field, the rows sit in a section per choice, each folding away
 * and asking for its own next page.
 *
 * What it changes it hands up: the screen applies it at once and undoes it if
 * the server refuses.
 */

import { useCrmT } from "./i18n";
import { useCustomFields, fieldLabel, optionLabel } from "./custom-fields";
import { TotalCell } from "./totals-row";
import { CellPicker } from "./cell-picker";
import type { Total } from "../lib/totals";
import { editorFor } from "./cell-editors";
import { HeaderCell } from "./table-header";
import Link from "next/link";
import { recordHref } from "../model/related";
import { ArrowUpRight, ChevronRight } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import type { RowGroup } from "./use-groups";
import { CellDisplay, OptionChip } from "./cell-display";
import type { InputValue } from "../model/values";
import { cn, Checkbox, useRangeSelection } from "@polaris/ui";
import type { Aggregate, ViewColumn, ViewSort } from "../model/views";
import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import {
    fieldOf,
    primaryField,
    type CrmObject,
    type CrmRecord,
    type FieldDef,
    type FieldValue,
    type Ref
} from "../model/objects";

/** The tick box column's width, and so where the name column is pinned. */
const BOX_WIDTH = 36;

/** Every row is this tall (`h-9`), so the rows off screen are measured, not drawn. */
const ROW_HEIGHT = 36;

/** From how many rows the table draws only the ones in sight: a list scrolled
 *  thousands of rows down keeps a page or two of rows in the document. */
const VIRTUAL_FROM = 120;

/** What `openInPanel` reads of a press. */
interface Press {
    readonly button: number;
    readonly metaKey: boolean;
    readonly ctrlKey: boolean;
    readonly shiftKey: boolean;
    readonly altKey: boolean;
    preventDefault(): void;
}

/**
 * A plain press on a record's link opens it in the side panel when the list
 * has one; a press with a modifier, or a middle press, is left to the browser
 * so the page still opens in a new tab.
 */
export function openInPanel(
    event: Press,
    id: string,
    onOpen: ((id: string) => void) | undefined
): void {
    if (!onOpen || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onOpen(id);
}

export interface TableProps {
    readonly object: CrmObject;
    /** The columns on screen, in order: the view's, without the hidden ones. */
    readonly columns: readonly ViewColumn[];
    readonly sorts: readonly ViewSort[];
    readonly rows: readonly CrmRecord[];
    readonly totals: readonly Total[];
    readonly people: readonly Ref[];
    readonly canEdit: boolean;
    /** Whether the reader may change the view's layout for everyone. */
    readonly canShape: boolean;
    readonly defaultCurrency: string;
    readonly selected: readonly string[];
    readonly onSelect: (ids: string[]) => void;
    /** A cell's new value: what to store, and what to show until the answer. */
    readonly onEdit: (
        record: CrmRecord,
        field: FieldDef,
        stored: InputValue,
        shown: FieldValue
    ) => void;
    readonly onSort: (key: string, direction: "asc" | "desc" | null) => void;
    readonly onColumns: (columns: ViewColumn[]) => void;
    /** Fields the reader's role may see but not change. */
    readonly locked?: readonly string[];
    readonly onAggregate: (key: string, aggregate: Aggregate | null) => void;
    /** A new record's name, typed into the row at the top; null when there is
     *  no such row open. */
    readonly draft: {
        readonly onCreate: (value: InputValue) => void;
        readonly onCancel: () => void;
    } | null;
    readonly hasMore: boolean;
    readonly loadingMore: boolean;
    readonly onLoadMore: () => void;
    /** Open a record in the side panel; without it the name links to its page. */
    readonly onOpen?: (id: string) => void;
    /** The rows in sections, one per choice of `groupField`; `rows` is then
     *  every row of every section, in order. */
    readonly grouping?: {
        readonly field: FieldDef;
        readonly groups: readonly RowGroup[];
        readonly loadingGroup: string | null;
        readonly onLoadMore: (value: string) => void;
    } | null;
}

interface Editing {
    readonly id: string;
    readonly key: string;
}

/** Ctrl+A chooses every row, but not while a field is being typed in. */
function fromField(event: KeyboardEvent): boolean {
    const target = event.target as HTMLElement;
    return target.closest("input, textarea, [contenteditable='true'], [role='menu']") !== null;
}

export function RecordTable(props: TableProps) {
    const { object, columns, rows, canEdit, selected, onSelect } = props;
    const t = useCrmT();
    const custom = useCustomFields();
    const [editing, setEditing] = useState<Editing | null>(null);
    const [folded, setFolded] = useState<ReadonlySet<string>>(() => new Set());
    const grouping = props.grouping ?? null;
    const scroller = useRef<HTMLDivElement>(null);
    const sentinel = useRef<HTMLTableRowElement>(null);
    const order = useMemo(
        () => rows.map((row) => row.id).filter((id) => !id.startsWith("draft:")),
        [rows]
    );
    const selection = useRangeSelection(order, selected, onSelect);
    const fields = useMemo(
        () =>
            columns
                .map((column) => {
                    const field = fieldOf(object, column.key, custom)!;
                    return {
                        column,
                        field:
                            field && props.locked?.includes(field.key)
                                ? { ...field, readOnly: true }
                                : field
                    };
                })
                .filter((one) => one.field),
        [columns, object, props.locked]
    );
    const virtual = !grouping && rows.length >= VIRTUAL_FROM;
    const rowWindow = useVirtualizer({
        count: rows.length,
        getScrollElement: () => scroller.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 16,
        enabled: virtual
    });
    const primary = primaryField(object);
    const allChosen =
        order.length > 0 &&
        selected.length >= order.length &&
        order.every((id) => selected.includes(id));

    // The next page is asked for when the end of the table scrolls into sight.
    const { hasMore, loadingMore, onLoadMore } = props;
    useEffect(() => {
        const end = sentinel.current;
        if (!end || !hasMore || loadingMore || grouping) return;
        const watch = new IntersectionObserver(
            (entries) => {
                if (entries.some((entry) => entry.isIntersecting)) onLoadMore();
            },
            { root: scroller.current, rootMargin: "200px" }
        );
        watch.observe(end);
        return () => watch.disconnect();
    }, [hasMore, loadingMore, onLoadMore, rows.length, grouping]);

    const pinned = (field: FieldDef) => (field.primary ? `${BOX_WIDTH}px` : undefined);

    const move = (dragged: string, before: string) => {
        const next = props.columns.filter((column) => column.key !== dragged);
        const moving = props.columns.find((column) => column.key === dragged);
        const at = next.findIndex((column) => column.key === before);
        if (!moving || at < 0) return;
        // The name stays first.
        next.splice(Math.max(1, at), 0, moving);
        props.onColumns(next);
    };

    const change = (key: string, patch: Partial<ViewColumn>) =>
        props.onColumns(
            props.columns.map((column) => (column.key === key ? { ...column, ...patch } : column))
        );

    const open = (record: CrmRecord, field: FieldDef) => {
        if (!canEdit || field.readOnly) return;
        if (field.kind === "boolean") {
            const next = !record.values[field.key];
            props.onEdit(record, field, next, next);
            return;
        }
        setEditing({ id: record.id, key: field.key });
    };

    const cell = (record: CrmRecord, field: FieldDef) => {
        const value = record.values[field.key];
        const active = editing?.id === record.id && editing.key === field.key;
        const close = () => setEditing(null);
        const Editor = active ? editorFor(field) : null;
        return (
            <td
                key={field.key}
                style={{ left: pinned(field) }}
                tabIndex={canEdit && !field.readOnly ? 0 : -1}
                aria-label={fieldLabel(t, object, field)}
                className={cn(
                    "relative h-9 border-b border-r border-border p-0 text-[0.8125rem]",
                    field.primary &&
                        "sticky z-[5] bg-card font-medium group-hover/row:bg-card-hover",
                    canEdit &&
                        !field.readOnly &&
                        "cursor-text hover:shadow-[inset_0_0_0_1px_hsl(var(--border-strong))]",
                    active && "z-30"
                )}
                onClick={(event) => {
                    // A press in a menu this cell opened arrives here through
                    // the portal; it is the menu's, not a press on the cell.
                    if (!event.currentTarget.contains(event.target as Node)) return;
                    open(record, field);
                }}
                onKeyDown={(event) => {
                    if (event.target !== event.currentTarget) return;
                    if (event.key === "Enter" || event.key === "F2") {
                        event.preventDefault();
                        open(record, field);
                    }
                }}
            >
                <div className="flex h-9 min-w-0 items-center overflow-hidden px-2.5">
                    <CellDisplay object={object} field={field} value={value} />
                    {field.primary && !record.id.startsWith("draft:") ? (
                        <Link
                            href={recordHref(object, record.id)}
                            onClick={(event) => {
                                event.stopPropagation();
                                openInPanel(event, record.id, props.onOpen);
                            }}
                            aria-label={t("record.open")}
                            title={t("record.open")}
                            className="ml-auto grid size-6 shrink-0 place-items-center rounded text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:opacity-100 md:opacity-0 md:group-hover/row:opacity-100"
                        >
                            <ArrowUpRight className="size-3.5" />
                        </Link>
                    ) : null}
                </div>
                {Editor ? (
                    <Editor
                        field={field}
                        value={value}
                        defaultCurrency={props.defaultCurrency}
                        onCancel={close}
                        onCommit={(next) => {
                            close();
                            props.onEdit(record, field, next, next as FieldValue);
                        }}
                    />
                ) : null}
                {active && !Editor ? (
                    <CellPicker
                        object={object}
                        field={field}
                        value={value}
                        people={props.people}
                        onClose={close}
                        onPick={(stored, shown) => {
                            close();
                            props.onEdit(record, field, stored, shown);
                        }}
                    />
                ) : null}
            </td>
        );
    };

    const row = (record: CrmRecord) => {
        const chosen = selected.includes(record.id);
        const pending = record.id.startsWith("draft:");
        return (
            <tr
                key={record.id}
                aria-selected={chosen}
                className={cn(
                    "group/row hover:bg-card-hover",
                    chosen && "bg-primary/5",
                    pending && "pointer-events-none opacity-60"
                )}
            >
                <td className="sticky left-0 z-[5] h-9 border-b border-r border-border bg-card p-0 group-hover/row:bg-card-hover">
                    <span className="flex h-9 items-center justify-center">
                        <Checkbox
                            checked={chosen}
                            disabled={pending}
                            aria-label={t("selection.row")}
                            onClick={(event) => {
                                selection.press(record.id, {
                                    shiftKey: event.shiftKey
                                });
                            }}
                            onChange={() => undefined}
                        />
                    </span>
                </td>
                {fields.map(({ field }) => cell(record, field))}
            </tr>
        );
    };

    /** The rows in sight, with the height of the ones above and below kept as
     *  two empty rows so the scroll bar and the sticky headings stay true. */
    const windowed = () => {
        const items = rowWindow.getVirtualItems();
        const before = items[0]?.start ?? 0;
        const after = rowWindow.getTotalSize() - (items[items.length - 1]?.end ?? 0);
        return (
            <>
                {before > 0 ? (
                    <tr aria-hidden style={{ height: before }}>
                        <td colSpan={fields.length + 1} className="p-0" />
                    </tr>
                ) : null}
                {items.map((item) => row(rows[item.index]!))}
                {after > 0 ? (
                    <tr aria-hidden style={{ height: after }}>
                        <td colSpan={fields.length + 1} className="p-0" />
                    </tr>
                ) : null}
            </>
        );
    };

    const groupLabel = (field: FieldDef, value: string) => optionLabel(t, object, field, value);

    const DraftEditor = props.draft ? editorFor(primary) : null;
    const totalWidth = BOX_WIDTH + fields.reduce((sum, { column }) => sum + column.width, 0);

    return (
        <div
            ref={scroller}
            className="min-h-0 flex-1 overflow-auto overscroll-contain rounded-lg border border-border bg-card"
            onKeyDown={(event) => {
                if (!fromField(event)) selection.onKeyDown(event);
            }}
        >
            <table
                className="table-fixed border-separate border-spacing-0"
                style={{ width: totalWidth }}
            >
                <colgroup>
                    <col style={{ width: BOX_WIDTH }} />
                    {fields.map(({ column }) => (
                        <col key={column.key} style={{ width: column.width }} />
                    ))}
                </colgroup>
                <thead>
                    <tr>
                        <th
                            scope="col"
                            className="sticky left-0 top-0 z-20 h-9 border-b border-r border-border bg-card p-0"
                        >
                            <span className="flex h-9 items-center justify-center">
                                <Checkbox
                                    checked={allChosen}
                                    disabled={rows.length === 0}
                                    aria-label={t("selection.all")}
                                    onChange={() => onSelect(allChosen ? [] : [...order])}
                                />
                            </span>
                        </th>
                        {fields.map(({ column, field }) => (
                            <HeaderCell
                                key={column.key}
                                object={object}
                                field={field}
                                column={column}
                                sort={props.sorts.find((sort) => sort.key === column.key)}
                                sticky={pinned(field)}
                                onSort={(direction) => props.onSort(column.key, direction)}
                                onHide={() => change(column.key, { hidden: true })}
                                onResize={(width) =>
                                    change(column.key, { width: Math.round(width) })
                                }
                                onMove={(dragged) => move(dragged, column.key)}
                            />
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {props.draft && DraftEditor ? (
                        <tr>
                            <td className="sticky left-0 z-[5] h-9 border-b border-r border-border bg-card" />
                            <td
                                style={{ left: `${BOX_WIDTH}px` }}
                                className="sticky z-30 h-9 border-b border-r border-border bg-card p-0"
                            >
                                <DraftEditor
                                    field={primary}
                                    value={undefined}
                                    onCommit={props.draft.onCreate}
                                    onCancel={props.draft.onCancel}
                                />
                            </td>
                            <td
                                colSpan={Math.max(1, fields.length - 1)}
                                className="border-b border-border"
                            />
                        </tr>
                    ) : null}
                    {grouping
                        ? grouping.groups.map((group) => {
                              const closed = folded.has(group.value);
                              const label = groupLabel(grouping.field, group.value);
                              return (
                                  <Fragment key={group.value}>
                                      <tr>
                                          <td
                                              colSpan={fields.length + 1}
                                              className="h-9 border-b border-border bg-muted/40 p-0"
                                          >
                                              <button
                                                  type="button"
                                                  aria-expanded={!closed}
                                                  onClick={() =>
                                                      setFolded((current) => {
                                                          const next = new Set(current);
                                                          if (closed) next.delete(group.value);
                                                          else next.add(group.value);
                                                          return next;
                                                      })
                                                  }
                                                  className="sticky left-0 flex h-9 max-w-[min(100%,24rem)] items-center gap-2 px-2.5 text-[0.8125rem]"
                                              >
                                                  <ChevronRight
                                                      className={cn(
                                                          "size-3.5 shrink-0 text-muted-foreground transition-transform duration-fast",
                                                          !closed && "rotate-90"
                                                      )}
                                                  />
                                                  <OptionChip
                                                      field={grouping.field}
                                                      option={group.value}
                                                      label={label}
                                                  />
                                                  <span className="tabular-nums text-muted-foreground">
                                                      {group.total}
                                                  </span>
                                              </button>
                                          </td>
                                      </tr>
                                      {closed ? null : group.rows.map(row)}
                                      {!closed && group.rows.length < group.total ? (
                                          <tr>
                                              <td
                                                  colSpan={fields.length + 1}
                                                  className="h-9 border-b border-border p-0"
                                              >
                                                  <button
                                                      type="button"
                                                      disabled={grouping.loadingGroup !== null}
                                                      onClick={() =>
                                                          grouping.onLoadMore(group.value)
                                                      }
                                                      className="sticky left-0 flex h-9 items-center px-3 text-[0.8125rem] text-muted-foreground hover:text-foreground disabled:opacity-60"
                                                  >
                                                      {grouping.loadingGroup === group.value
                                                          ? t("list.loadingMore")
                                                          : t("board.more", {
                                                                count:
                                                                    group.total - group.rows.length
                                                            })}
                                                  </button>
                                              </td>
                                          </tr>
                                      ) : null}
                                  </Fragment>
                              );
                          })
                        : virtual
                          ? windowed()
                          : rows.map(row)}
                    <tr ref={sentinel} aria-hidden>
                        <td colSpan={fields.length + 1} className="h-px p-0">
                            {loadingMore ? (
                                <span className="flex h-9 items-center px-3 text-[0.8125rem] text-muted-foreground">
                                    {t("list.loadingMore")}
                                </span>
                            ) : null}
                        </td>
                    </tr>
                </tbody>
                <tfoot className="group/foot">
                    <tr>
                        <td className="sticky bottom-0 left-0 z-20 border-r border-t border-border bg-card" />
                        {fields.map(({ column, field }) => (
                            <TotalCell
                                key={column.key}
                                object={object}
                                field={field}
                                column={column}
                                total={props.totals.find((total) => total.key === column.key)}
                                sticky={pinned(field)}
                                canChange={props.canShape}
                                onChange={(aggregate) => props.onAggregate(column.key, aggregate)}
                            />
                        ))}
                    </tr>
                </tfoot>
            </table>
        </div>
    );
}
