"use client";

/**
 * The pieces every automation editor is drawn with: the WHEN / IF / THEN stages
 * of the form layout, the card one node is edited in, a field that carries the
 * complaint about its own value, and the menus that add a node or choose how a
 * group's conditions combine.
 *
 * What a node holds is the editor's own business - a device and a state for
 * Places, a header and a pattern for Mail - so nothing here knows a kind. Every
 * word arrives as a prop, already in the reader's language.
 *
 * A list of cards can be put in another order by dragging a card's handle, or
 * with the arrow keys on it (`SortableList`); the order is the definition's own
 * list order, so it is what gets saved.
 */

import { cn } from "../lib/cn";
import { Button } from "../components/button";
import { Select } from "../components/select";
import type { FlowMatch, Path } from "./graph";
import { moved, useListOrder } from "../lib/list-order";
import { ArrowDown, ArrowUp, GripVertical, Plus, X } from "lucide-react";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "../components/dropdown-menu";
import { createContext, useContext, useEffect, useId, useState, type ReactNode } from "react";

/** Where the complaints for the node being drawn are looked up. */
export interface IssueLookup {
    (path: Path): string | undefined;
}

const IssueContext = createContext<IssueLookup>(() => undefined);

export const IssueProvider = IssueContext.Provider;

export function useIssue(path: Path): string | undefined {
    return useContext(IssueContext)(path);
}

/** A label, the control, and the complaint about it. A `*` marks what has to be
 *  filled in, so an empty one reads as unfinished rather than wrong. */
export function Field({
    label,
    path,
    required,
    className,
    children
}: {
    label: string;
    path: Path;
    required?: boolean;
    className?: string;
    children: (id: string, invalid: boolean) => ReactNode;
}) {
    const id = useId();
    const issue = useIssue(path);
    return (
        <div className={cn("flex min-w-0 flex-col gap-1", className)}>
            <label htmlFor={id} className="text-[0.6875rem] font-medium text-muted-foreground">
                {label}
                {required && <span aria-hidden="true"> *</span>}
            </label>
            {children(id, issue !== undefined)}
            {issue && (
                <p id={`${id}-issue`} className="text-[0.6875rem] text-danger">
                    {issue}
                </p>
            )}
        </div>
    );
}

/** One card in the flow: its kind, its fields, and the buttons that move it. */
export function NodeCard({
    handle,
    number,
    kind,
    onRemove,
    onUp,
    onDown,
    removeLabel,
    upLabel,
    downLabel,
    disabled,
    children
}: {
    number?: number;
    kind: ReactNode;
    onRemove: () => void;
    onUp?: () => void;
    onDown?: () => void;
    removeLabel: string;
    upLabel: string;
    downLabel: string;
    disabled?: boolean;
    children?: ReactNode;
    /** The drag handle a `SortableList` hands its row. */
    handle?: ReactNode;
}) {
    return (
        <div className="relative flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
            <div className="flex items-center gap-2">
                {!disabled && handle}
                {number !== undefined && (
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-[0.6875rem] font-medium tabular-nums text-muted-foreground">
                        {number}
                    </span>
                )}
                <div className="min-w-0 flex-1">{kind}</div>
                {!disabled && (
                    <span className="flex shrink-0 items-center">
                        {onUp && (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="size-7 p-0"
                                aria-label={upLabel}
                                title={upLabel}
                                onClick={onUp}
                            >
                                <ArrowUp className="size-3.5" />
                            </Button>
                        )}
                        {onDown && (
                            <Button
                                size="sm"
                                variant="ghost"
                                className="size-7 p-0"
                                aria-label={downLabel}
                                title={downLabel}
                                onClick={onDown}
                            >
                                <ArrowDown className="size-3.5" />
                            </Button>
                        )}
                        <Button
                            size="sm"
                            variant="ghost"
                            className="size-7 p-0"
                            aria-label={removeLabel}
                            title={removeLabel}
                            onClick={onRemove}
                        >
                            <X className="size-3.5" />
                        </Button>
                    </span>
                )}
            </div>
            {children && <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{children}</div>}
        </div>
    );
}

/**
 * Cards that can be put in another order: dragged by the handle each row is
 * handed, or moved with the arrow keys on that handle. `onMove` is told where
 * a card went, and the caller reorders its own list - `moved` does exactly that.
 * Nests: a group's conditions can be a list inside the list of groups, and a
 * card dragged in one never picks up the card around it.
 */
export function SortableList<T extends { readonly id: string }>({
    items,
    label,
    handleLabel,
    disabled,
    onMove,
    children
}: {
    items: readonly T[];
    /** What the list is, for a screen reader. */
    label: string;
    handleLabel: string;
    disabled?: boolean;
    onMove: (from: number, to: number) => void;
    /** One row, given the handle to put in its heading. */
    children: (item: T, index: number, handle: ReactNode) => ReactNode;
}) {
    const order = useListOrder(
        items.length,
        onMove,
        items.map((item) => item.id)
    );
    const sortable = !disabled && items.length > 1;
    const line = (
        <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-primary"
        />
    );
    return (
        <ul
            aria-label={label}
            className="flex min-w-0 flex-col gap-2"
            {...(sortable ? order.listProps : {})}
        >
            {items.map((item, index) => (
                <li
                    key={item.id}
                    className={cn("relative min-w-0", order.dragging === index && "opacity-40")}
                    {...(sortable ? order.rowProps(index) : {})}
                >
                    {order.dragging !== null && order.dropAt === index && (
                        <span className="absolute inset-x-0 -top-1.5">{line}</span>
                    )}
                    {children(
                        item,
                        index,
                        sortable ? (
                            <button
                                type="button"
                                aria-label={handleLabel}
                                title={handleLabel}
                                className="flex size-7 shrink-0 cursor-grab touch-none items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
                                {...order.handleProps(index, items.length)}
                            >
                                <GripVertical className="size-3.5" />
                            </button>
                        ) : null
                    )}
                    {order.dragging !== null &&
                        order.dropAt === items.length &&
                        index === items.length - 1 && (
                            <span className="absolute inset-x-0 -bottom-1.5">{line}</span>
                        )}
                </li>
            ))}
        </ul>
    );
}

export { moved };

/** One of WHEN, IF and THEN: a heading on the line, its cards, and the line
 *  carried down to the next. */
export function Stage({
    icon,
    title,
    hint,
    issue,
    last,
    children
}: {
    icon: ReactNode;
    title: string;
    hint: string;
    issue?: string;
    last?: boolean;
    children: ReactNode;
}) {
    return (
        <li className="relative flex gap-3 pb-5">
            {!last && (
                <span
                    aria-hidden="true"
                    className="absolute bottom-0 left-[0.9375rem] top-8 w-px bg-border"
                />
            )}
            <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full border border-border bg-card text-muted-foreground">
                {icon}
            </span>
            <section className="flex min-w-0 flex-1 flex-col gap-2 pt-1">
                <header className="flex flex-wrap items-baseline gap-x-2">
                    <h2 className="text-xs font-semibold uppercase tracking-wide">{title}</h2>
                    <p className="text-xs text-muted-foreground">{hint}</p>
                </header>
                {children}
                {issue && <p className="text-xs text-danger">{issue}</p>}
            </section>
        </li>
    );
}

/** A dashed "add" button that opens the kinds it can add. */
export function AddMenu({
    label,
    options,
    onPick
}: {
    label: string;
    options: readonly { value: string; label: string }[];
    onPick: (value: string) => void;
}) {
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button size="sm" variant="outline" className="self-start border-dashed">
                    <Plus className="size-4 shrink-0" />
                    {label}
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start">
                {options.map((option) => (
                    <DropdownMenuItem key={option.value} onSelect={() => onPick(option.value)}>
                        {option.label}
                    </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

/** Whether all of something has to hold, or any one of it. */
export function MatchPicker({
    value,
    onChange,
    label,
    allLabel,
    anyLabel,
    disabled
}: {
    value: FlowMatch;
    onChange: (value: FlowMatch) => void;
    label: string;
    allLabel: string;
    anyLabel: string;
    disabled?: boolean;
}) {
    return (
        <Select
            value={value}
            disabled={disabled}
            aria-label={label}
            className="w-auto self-start"
            options={[
                { value: "all", label: allLabel },
                { value: "any", label: anyLabel }
            ]}
            onValueChange={(next) => onChange(next as FlowMatch)}
        />
    );
}

/** A node's kind, as the heading of its card that can be changed in place. */
export function KindPicker<K extends string>({
    value,
    kinds: offered,
    label,
    text,
    disabled,
    onChange
}: {
    value: K;
    kinds: readonly K[];
    label: string;
    text: (kind: K) => string;
    disabled?: boolean;
    onChange: (kind: K) => void;
}) {
    return (
        <Select
            value={value}
            disabled={disabled}
            aria-label={label}
            className="h-7 w-auto max-w-full border-transparent bg-transparent px-1 font-medium hover:border-border"
            options={offered.map((kind) => ({ value: kind, label: text(kind) }))}
            onValueChange={(next) => onChange(next as K)}
        />
    );
}

/** The flow as a column of cards, or as a diagram. */
export type FlowLayout = "form" | "visual";

/**
 * The reader's choice between the two layouts, kept in this browser only under
 * `key`: a preference about how to look at the screen, not about the
 * automation. Read after the first paint, because the server has no storage to
 * ask and the two must draw the same thing first.
 */
export function useFlowLayout(key: string): [FlowLayout, (layout: FlowLayout) => void] {
    const [layout, setLayout] = useState<FlowLayout>("form");
    useEffect(() => {
        try {
            setLayout(window.localStorage.getItem(key) === "visual" ? "visual" : "form");
        } catch {
            // No storage here: the form it is.
        }
    }, [key]);
    const choose = (next: FlowLayout) => {
        setLayout(next);
        try {
            window.localStorage.setItem(key, next);
        } catch {
            // No storage here: the choice lasts as long as the page does.
        }
    };
    return [layout, choose];
}
