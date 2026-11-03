"use client";

/**
 * A picker over a list too long to hand the browser: the options are read from
 * the server as the menu opens, narrowed by the server as somebody types, and
 * read a page further as they scroll towards the end.
 *
 * The same menu as `SearchableSelect` - portalled, kept on screen, its search
 * box pinned above the list (see `MenuSearch`) - with the list itself drawn
 * through a virtualizer, so a menu scrolled two thousand rows down still only
 * has the rows on screen in the page. Paging, search and the cache are
 * `useAsyncOptions`.
 *
 * What is chosen is named on the trigger without the list it came from: from
 * `selectedLabel` when the screen already knows it, from a row the menu has
 * already read, or by asking `resolve` for that one value.
 */

import { cn } from "../lib/cn";
import { useTranslations } from "../i18n";
import { MenuSearch } from "./menu-search";
import { Check, ChevronDown } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useAsyncOptions, type AsyncLoad } from "../lib/use-async-options";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "./dropdown-menu";

/** Height of one row, which the virtualizer lays the list out by. */
const ROW_HEIGHT = 32;
/** Rows from the end at which the next page is asked for. */
const PREFETCH_ROWS = 8;
/** Skeleton rows while a first page is on its way. */
const SKELETON_ROWS = 6;

/** An option that is not read from the server - "Any server", "This machine". */
export interface AsyncFixedOption {
    readonly value: string;
    readonly label: string;
}

interface AsyncPickerBaseProps<T> {
    load: AsyncLoad<T>;
    /** Names the list and its filters, so pages are cached under it. */
    cacheKey: string;
    itemValue: (item: T) => string;
    itemLabel: (item: T) => string;
    /** Quieter words after the label - an address, a status. */
    itemDetail?: (item: T) => string | null | undefined;
    itemIcon?: (item: T) => ReactNode;
    itemDisabled?: (item: T) => boolean;
    /** Options above what the server lists, matched against the search here. */
    fixed?: readonly AsyncFixedOption[];
    /** Reads one value back when nothing on screen names it yet. */
    resolve?: (value: string) => Promise<T | null>;
    placeholder?: string;
    searchPlaceholder?: string;
    emptyText?: string;
    disabled?: boolean;
    className?: string;
    contentClassName?: string;
    id?: string;
    "aria-label"?: string;
}

export interface AsyncSelectProps<T> extends AsyncPickerBaseProps<T> {
    value: string | null;
    /** The item is null for one of the `fixed` options. */
    onValueChange: (value: string, item: T | null) => void;
    /** The chosen value's words, when the screen already has them. */
    selectedLabel?: string;
}

export interface AsyncMultiSelectProps<T> extends AsyncPickerBaseProps<T> {
    values: readonly string[];
    onValuesChange: (values: string[]) => void;
    /** Words for chosen values the screen already has, by value. */
    selectedLabels?: Readonly<Record<string, string>>;
}

/** Labels of every row read so far, so a choice is named after the menu closes. */
function useSeenLabels<T>(
    items: readonly T[],
    itemValue: (item: T) => string,
    itemLabel: (item: T) => string,
    fixed: readonly AsyncFixedOption[] | undefined
) {
    const seen = useRef(new Map<string, string>());
    for (const option of fixed ?? []) seen.current.set(option.value, option.label);
    for (const item of items) seen.current.set(itemValue(item), itemLabel(item));
    return seen.current;
}

/** The label of each chosen value no one on screen has named, read one by one. */
function useResolvedLabels<T>(
    values: readonly string[],
    known: (value: string) => string | undefined,
    resolve: ((value: string) => Promise<T | null>) | undefined,
    itemLabel: (item: T) => string
): { labels: ReadonlyMap<string, string>; pending: boolean } {
    const [labels, setLabels] = useState<ReadonlyMap<string, string>>(new Map());
    const missing = values.filter((value) => known(value) === undefined && !labels.has(value));
    const wanted = missing.join("\u0000");
    useEffect(() => {
        if (!resolve || wanted === "") return;
        let live = true;
        for (const value of wanted.split("\u0000")) {
            resolve(value)
                .then((item) => {
                    if (!live || !item) return;
                    setLabels((before) => new Map(before).set(value, itemLabel(item)));
                })
                .catch(() => undefined);
        }
        return () => {
            live = false;
        };
        // itemLabel is a render function, not a question.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [wanted, resolve]);
    return { labels, pending: resolve !== undefined && missing.length > 0 };
}

function AsyncPicker<T>({
    multiple,
    chosen,
    toggle,
    trigger,
    load,
    cacheKey,
    itemValue,
    itemLabel,
    itemDetail,
    itemIcon,
    itemDisabled,
    fixed,
    searchPlaceholder,
    emptyText,
    disabled,
    className,
    contentClassName,
    id,
    "aria-label": ariaLabel,
    onItems
}: AsyncPickerBaseProps<T> & {
    multiple: boolean;
    chosen: ReadonlySet<string>;
    toggle: (value: string, item: T | null) => void;
    trigger: ReactNode;
    onItems: (items: readonly T[]) => void;
}) {
    const t = useTranslations("components");
    const [open, setOpen] = useState(false);
    const [query, setQuery] = useState("");
    const list = useAsyncOptions({ load, cacheKey, open, query });
    useEffect(() => onItems(list.items), [list.items, onItems]);

    const shownFixed = useMemo(() => {
        const needle = query.trim().toLowerCase();
        return (fixed ?? []).filter((option) => option.label.toLowerCase().includes(needle));
    }, [fixed, query]);
    const rows = list.items.length + (list.loadingMore ? 1 : 0);

    const scroller = useRef<HTMLDivElement | null>(null);
    const virtual = useVirtualizer({
        count: rows,
        getScrollElement: () => scroller.current,
        estimateSize: () => ROW_HEIGHT,
        overscan: 6,
        // Laid out before the menu has measured itself, so the first page is
        // drawn on the frame the menu opens rather than the one after.
        initialRect: { width: 0, height: ROW_HEIGHT * 9 }
    });
    const drawn = virtual.getVirtualItems();
    const lastDrawn = drawn[drawn.length - 1]?.index ?? -1;
    const { hasMore, loadMore } = list;
    useEffect(() => {
        if (hasMore && lastDrawn >= list.items.length - PREFETCH_ROWS) loadMore();
    }, [hasMore, lastDrawn, list.items.length, loadMore]);

    const empty =
        !list.loading && !list.failed && list.items.length === 0 && shownFixed.length === 0;
    const status = list.loading
        ? t("asyncSelect.loading")
        : list.failed
          ? t("asyncSelect.failed")
          : empty
            ? (emptyText ?? t("asyncSelect.empty"))
            : "";

    const row = (value: string, label: string, item: T | null, detail?: string | null) => (
        <DropdownMenuItem
            key={value}
            disabled={item !== null && itemDisabled?.(item)}
            role={multiple ? "menuitemcheckbox" : "menuitem"}
            aria-checked={multiple ? chosen.has(value) : undefined}
            onSelect={(event) => {
                // Several can be picked without the menu closing between them.
                if (multiple) event.preventDefault();
                toggle(value, item);
            }}
            className="h-8 pr-8"
        >
            {item !== null && itemIcon ? (
                <span className="flex shrink-0 items-center">{itemIcon(item)}</span>
            ) : null}
            <span
                className="min-w-0 flex-1 truncate"
                title={detail ? `${label} - ${detail}` : label}
            >
                {label}
            </span>
            {detail ? (
                <span className="min-w-0 max-w-[45%] shrink truncate text-[0.75rem] text-muted-foreground">
                    {detail}
                </span>
            ) : null}
            {chosen.has(value) && <Check className="absolute right-2 text-primary" />}
        </DropdownMenuItem>
    );

    return (
        <DropdownMenu
            onOpenChange={(next) => {
                setOpen(next);
                // An old search is not what somebody reopening the menu is after.
                setQuery("");
            }}
        >
            <DropdownMenuTrigger
                id={id}
                disabled={disabled}
                aria-label={ariaLabel}
                className={cn(
                    "group flex h-8 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-border bg-field px-2.5 text-left text-[0.8125rem] transition-colors duration-fast hover:border-border-strong disabled:cursor-not-allowed disabled:opacity-50 data-[state=open]:border-border-strong",
                    className
                )}
            >
                {trigger}
                <ChevronDown className="size-4 shrink-0 text-muted-foreground transition-transform duration-150 group-data-[state=open]:rotate-180" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className={cn(
                    "flex max-h-[min(22rem,var(--radix-dropdown-menu-content-available-height))] min-w-[--radix-dropdown-menu-trigger-width] max-w-[min(32rem,100vw-2rem)] flex-col",
                    contentClassName
                )}
            >
                <MenuSearch
                    value={query}
                    onChange={setQuery}
                    placeholder={searchPlaceholder ?? t("asyncSelect.search")}
                    className="-mx-1 -mt-1 bg-elevated px-3 pt-2"
                />
                {shownFixed.map((option) => row(option.value, option.label, null))}
                <p role="status" aria-live="polite" className="sr-only">
                    {status}
                </p>
                {list.loading ? (
                    <div aria-hidden className="flex flex-col gap-1 px-2 py-1">
                        {Array.from({ length: SKELETON_ROWS }, (_, at) => (
                            <div key={at} className="h-6 animate-pulse rounded bg-muted" />
                        ))}
                    </div>
                ) : list.failed && list.items.length === 0 ? (
                    <div className="flex items-center justify-between gap-2 px-2 py-3 text-[0.75rem] text-muted-foreground">
                        <span className="min-w-0">{t("asyncSelect.failed")}</span>
                        <button
                            type="button"
                            className="shrink-0 font-medium text-primary hover:underline"
                            onClick={list.retry}
                        >
                            {t("asyncSelect.retry")}
                        </button>
                    </div>
                ) : empty ? (
                    <p className="px-2 py-3 text-[0.75rem] text-muted-foreground">
                        {emptyText ?? t("asyncSelect.empty")}
                    </p>
                ) : (
                    <div
                        ref={scroller}
                        aria-busy={list.loadingMore}
                        className="min-h-0 flex-1 overflow-y-auto"
                    >
                        <div className="relative w-full" style={{ height: virtual.getTotalSize() }}>
                            {drawn.map((slot) => {
                                const item = list.items[slot.index];
                                return (
                                    <div
                                        key={slot.key}
                                        className="absolute inset-x-0 top-0"
                                        style={{ transform: `translateY(${slot.start}px)` }}
                                    >
                                        {item === undefined ? (
                                            <div aria-hidden className="px-2 py-1">
                                                <div className="h-6 animate-pulse rounded bg-muted" />
                                            </div>
                                        ) : (
                                            row(
                                                itemValue(item),
                                                itemLabel(item),
                                                item,
                                                itemDetail?.(item)
                                            )
                                        )}
                                    </div>
                                );
                            })}
                        </div>
                        {list.failed ? (
                            <div className="flex items-center justify-between gap-2 px-2 py-2 text-[0.75rem] text-muted-foreground">
                                <span className="min-w-0">{t("asyncSelect.failedMore")}</span>
                                <button
                                    type="button"
                                    className="shrink-0 font-medium text-primary hover:underline"
                                    onClick={list.retry}
                                >
                                    {t("asyncSelect.retry")}
                                </button>
                            </div>
                        ) : null}
                    </div>
                )}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function TriggerText({ label, placeholder }: { label: string | null; placeholder?: string }) {
    return label !== null ? (
        <span className="min-w-0 truncate" title={label}>
            {label}
        </span>
    ) : (
        <span className="min-w-0 truncate text-foreground-subtle">{placeholder ?? ""}</span>
    );
}

/** One value out of a server-read list. */
export function AsyncSelect<T>(props: AsyncSelectProps<T>) {
    const { value, onValueChange, selectedLabel, itemValue, itemLabel, fixed, resolve } = props;
    const [items, setItems] = useState<readonly T[]>([]);
    const seen = useSeenLabels(items, itemValue, itemLabel, fixed);
    const values = value ? [value] : [];
    const known = (one: string) => (one === value ? selectedLabel : undefined) ?? seen.get(one);
    const resolved = useResolvedLabels(values, known, resolve, itemLabel);
    const label = value ? (known(value) ?? resolved.labels.get(value) ?? null) : null;
    const chosen = useMemo(() => new Set(value ? [value] : []), [value]);

    return (
        <AsyncPicker
            {...props}
            multiple={false}
            chosen={chosen}
            onItems={setItems}
            toggle={(next, item) => onValueChange(next, item)}
            trigger={
                label === null && value && resolved.pending ? (
                    <span aria-hidden className="h-3.5 w-24 animate-pulse rounded bg-muted" />
                ) : (
                    <TriggerText label={label} placeholder={props.placeholder} />
                )
            }
        />
    );
}

/** Any number of values out of a server-read list. */
export function AsyncMultiSelect<T>(props: AsyncMultiSelectProps<T>) {
    const { values, onValuesChange, selectedLabels, itemValue, itemLabel, fixed, resolve } = props;
    const t = useTranslations("components");
    const [items, setItems] = useState<readonly T[]>([]);
    const seen = useSeenLabels(items, itemValue, itemLabel, fixed);
    const known = (one: string) => selectedLabels?.[one] ?? seen.get(one);
    const resolved = useResolvedLabels(values, known, resolve, itemLabel);
    const chosen = useMemo(() => new Set(values), [values]);
    const first = values[0];
    const label =
        first === undefined
            ? null
            : values.length === 1
              ? (known(first) ?? resolved.labels.get(first) ?? null)
              : t("asyncSelect.selected", { count: values.length });

    return (
        <AsyncPicker
            {...props}
            multiple
            chosen={chosen}
            onItems={setItems}
            toggle={(value) =>
                onValuesChange(
                    chosen.has(value) ? values.filter((one) => one !== value) : [...values, value]
                )
            }
            trigger={<TriggerText label={label} placeholder={props.placeholder} />}
        />
    );
}
