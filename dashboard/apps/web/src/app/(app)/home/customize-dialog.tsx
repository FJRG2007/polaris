"use client";

/**
 * Arranging the Overview: which cards are on it, in what order, and how wide.
 *
 * A row can be dragged, and it can be moved with two buttons, and both are here
 * on purpose. Dragging is the gesture people reach for; it is also unreachable
 * from a keyboard and does not fire at all on a touch screen, so it cannot be the
 * only way to arrange your own screen. The buttons work everywhere and say what
 * they do.
 *
 * Every change applies to the grid behind the panel as it is made, so the effect
 * of a choice is visible while the choice is being made rather than after
 * closing a modal.
 */

import { useState } from "react";
import { overviewWidget } from "@/lib/overview/catalog";
import { sizeLabel, widgetDescription, widgetLabel } from "./widget-names";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { ArrowDown, ArrowUp, GripVertical, RotateCcw } from "lucide-react";
import type { OverviewWidgetId, OverviewWidgetPreference, OverviewWidgetSize } from "@polaris/core";
import { Button, Dialog, DialogContent, DialogHeader, DialogTitle, Select, Switch, cn } from "@polaris/ui";

export function CustomizeDialog({
    open,
    onOpenChange,
    layout,
    greeting,
    onMove,
    onMoveOnto,
    onToggle,
    onResize,
    onGreetingChange,
    onReset,
    extra
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    layout: readonly OverviewWidgetPreference[];
    greeting: boolean;
    onMove: (id: OverviewWidgetId, direction: -1 | 1) => void;
    /** Put one card where another one is, for a row that was dragged onto it. */
    onMoveOnto: (id: OverviewWidgetId, target: OverviewWidgetId) => void;
    onToggle: (id: OverviewWidgetId, visible: boolean) => void;
    onResize: (id: OverviewWidgetId, size: OverviewWidgetSize) => void;
    onGreetingChange: (greeting: boolean) => void;
    onReset: () => void;
    /** More to choose from under the Overview's own cards - the installed
     *  apps' cards. */
    extra?: React.ReactNode;
}) {
    const t = useTranslations("home");
    const [dragged, setDragged] = useState<OverviewWidgetId | null>(null);
    const [over, setOver] = useState<OverviewWidgetId | null>(null);

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("customize.title")}</DialogTitle>
                </DialogHeader>

                <ul className="-mx-1 max-h-[min(60vh,26rem)] overflow-y-auto overscroll-contain px-1">
                    {layout.map((widget, index) => {
                        const entry = overviewWidget(widget.id);
                        const Icon = entry.icon;
                        const label = widgetLabel(t, widget.id, entry.label);
                        const description = widgetDescription(t, widget.id, entry.description);
                        return (
                            <li
                                key={widget.id}
                                className={cn(
                                    "flex items-center gap-3 border-b border-border/60 py-3 last:border-b-0",
                                    widget.hidden && "opacity-60",
                                    dragged === widget.id && "opacity-40",
                                    over === widget.id && dragged !== widget.id && "rounded-md ring-2 ring-primary"
                                )}
                                onDragOver={(event) => {
                                    if (!dragged) return;
                                    event.preventDefault();
                                    event.dataTransfer.dropEffect = "move";
                                    setOver(widget.id);
                                }}
                                onDragLeave={() => setOver((held) => (held === widget.id ? null : held))}
                                onDrop={(event) => {
                                    event.preventDefault();
                                    if (dragged) onMoveOnto(dragged, widget.id);
                                    setDragged(null);
                                    setOver(null);
                                }}
                            >
                                <span
                                    draggable
                                    title={t("card.drag", { name: label })}
                                    aria-hidden="true"
                                    onDragStart={(event) => {
                                        event.dataTransfer.setData("text/plain", widget.id);
                                        event.dataTransfer.effectAllowed = "move";
                                        setDragged(widget.id);
                                    }}
                                    onDragEnd={() => {
                                        setDragged(null);
                                        setOver(null);
                                    }}
                                    className="-ml-1 grid size-5 shrink-0 cursor-grab place-items-center text-muted-foreground/50 transition-colors hover:text-foreground active:cursor-grabbing"
                                >
                                    <GripVertical className="size-4" aria-hidden="true" />
                                </span>
                                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                                <div className="flex min-w-0 flex-1 flex-col">
                                    <span className="truncate text-sm font-medium" title={label}>{label}</span>
                                    <span className="truncate text-xs text-muted-foreground" title={description}>{description}</span>
                                </div>

                                {entry.sizes.length > 1 && !widget.hidden ? (
                                    <Select
                                        value={widget.size}
                                        onValueChange={(value) => onResize(widget.id, value as OverviewWidgetSize)}
                                        aria-label={t("customize.width", { name: label })}
                                        className="h-8 w-28 shrink-0"
                                        options={entry.sizes.map((size) => ({ value: size, label: sizeLabel(t, size) }))}
                                    />
                                ) : null}

                                <div className="flex shrink-0 items-center">
                                    <button
                                        type="button"
                                        disabled={index === 0}
                                        onClick={() => onMove(widget.id, -1)}
                                        title={t("customize.moveUp", { name: label })}
                                        aria-label={t("customize.moveUp", { name: label })}
                                        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                                    >
                                        <ArrowUp className="size-4" aria-hidden="true" />
                                    </button>
                                    <button
                                        type="button"
                                        disabled={index === layout.length - 1}
                                        onClick={() => onMove(widget.id, 1)}
                                        title={t("customize.moveDown", { name: label })}
                                        aria-label={t("customize.moveDown", { name: label })}
                                        className="grid size-7 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
                                    >
                                        <ArrowDown className="size-4" aria-hidden="true" />
                                    </button>
                                </div>

                                <Switch
                                    checked={!widget.hidden}
                                    onChange={(checked) => onToggle(widget.id, checked)}
                                    aria-label={t("customize.show", { name: label })}
                                />
                            </li>
                        );
                    })}
                </ul>

                {extra}

                <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                    <label className="flex items-center gap-2 text-sm">
                        <Switch checked={greeting} onChange={onGreetingChange} aria-label={t("customize.greet")} />
                        {t("customize.greet")}
                    </label>
                    <Button variant="ghost" size="sm" onClick={onReset}>
                        <RotateCcw className="size-4" aria-hidden="true" />
                        {t("customize.reset")}
                    </Button>
                </div>
            </DialogContent>
        </Dialog>
    );
}
