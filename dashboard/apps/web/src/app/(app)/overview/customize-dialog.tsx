"use client";

/**
 * Arranging the Overview: which cards are on it, in what order, and how wide.
 *
 * Ordering is a pair of buttons rather than dragging. Dragging is the obvious
 * gesture and a poor contract: it is unreachable from the keyboard, awkward on a
 * touch screen, and the one thing this panel must be is operable by whoever is
 * arranging their own screen. The same two buttons work everywhere and announce
 * themselves.
 *
 * Every change applies to the grid behind the panel as it is made, so the effect
 * of a choice is visible while the choice is being made rather than after
 * closing a modal.
 */

import { overviewWidget } from "@/lib/overview/catalog";
import { ArrowDown, ArrowUp, RotateCcw } from "lucide-react";
import type { OverviewWidgetId, OverviewWidgetPreference, OverviewWidgetSize } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Select, Switch, cn } from "@polaris/ui";

const SIZE_LABELS: Record<OverviewWidgetSize, string> = {
    sm: "Narrow",
    md: "Medium",
    lg: "Full width"
};

export function CustomizeDialog({
    open,
    onOpenChange,
    layout,
    greeting,
    onMove,
    onToggle,
    onResize,
    onGreetingChange,
    onReset
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    layout: readonly OverviewWidgetPreference[];
    greeting: boolean;
    onMove: (id: OverviewWidgetId, direction: -1 | 1) => void;
    onToggle: (id: OverviewWidgetId, visible: boolean) => void;
    onResize: (id: OverviewWidgetId, size: OverviewWidgetSize) => void;
    onGreetingChange: (greeting: boolean) => void;
    onReset: () => void;
}) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>Customize your Overview</DialogTitle>
                </DialogHeader>

                <ul className="-mx-1 max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain px-1">
                    {layout.map((widget, index) => {
                        const entry = overviewWidget(widget.id);
                        const Icon = entry.icon;
                        return (
                            <li
                                key={widget.id}
                                className={cn(
                                    "flex items-center gap-3 border-b border-border/60 py-3 last:border-b-0",
                                    widget.hidden && "opacity-60"
                                )}
                            >
                                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                <div className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate text-sm font-medium" title={entry.label}>{entry.label}</span>
                                    <span className="truncate text-xs text-muted-foreground" title={entry.description}>{entry.description}</span>
                                </div>

                                {entry.sizes.length > 1 && !widget.hidden ? (
                                    <Select
                                        value={widget.size}
                                        onValueChange={(value) => onResize(widget.id, value as OverviewWidgetSize)}
                                        aria-label={`Width of ${entry.label}`}
                                        className="h-8 w-28 shrink-0"
                                        options={entry.sizes.map((size) => ({ value: size, label: SIZE_LABELS[size] }))}
                                    />
                                ) : null}

                                <div className="flex shrink-0 items-center">
                                    <button
                                        type="button"
                                        disabled={index === 0}
                                        onClick={() => onMove(widget.id, -1)}
                                        title={`Move ${entry.label} up`}
                                        aria-label={`Move ${entry.label} up`}
                                        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                                    >
                                        <ArrowUp className="size-4" aria-hidden="true" />
                                    </button>
                                    <button
                                        type="button"
                                        disabled={index === layout.length - 1}
                                        onClick={() => onMove(widget.id, 1)}
                                        title={`Move ${entry.label} down`}
                                        aria-label={`Move ${entry.label} down`}
                                        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                                    >
                                        <ArrowDown className="size-4" aria-hidden="true" />
                                    </button>
                                </div>

                                <Switch
                                    checked={!widget.hidden}
                                    onChange={(checked) => onToggle(widget.id, checked)}
                                    aria-label={`Show ${entry.label}`}
                                />
                            </li>
                        );
                    })}
                </ul>

                <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                    <label className="flex items-center gap-2 text-sm">
                        <Switch checked={greeting} onChange={onGreetingChange} aria-label="Greet me by name" />
                        Greet me by name
                    </label>
                    <Button variant="ghost" size="sm" onClick={onReset}>
                        <RotateCcw className="size-4" aria-hidden="true" />
                        Reset
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
