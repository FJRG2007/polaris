"use client";

/**
 * Inserting a table and a chart, from the toolbar.
 *
 * A table's size is picked off a grid, as Google Slides and PowerPoint both
 * offer it: point at (or arrow to) the corner of the table wanted and press.
 * A chart is picked by kind and lands with made-up numbers, ready for its data
 * to be typed in.
 */

import { CHART_ICON } from "./object-controls";
import * as charts from "@/lib/office/slide-chart";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    cn,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger
} from "@polaris/ui";
import { ChartColumn, ChevronDown, Table2 } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";

/** The grid offered: as many columns across and rows down as a slide table
 *  usually needs; a larger one grows from the format bar. */
const PICK_COLS = 10;
const PICK_ROWS = 8;

export function TableMenu({ onPick }: { onPick: (rows: number, cols: number) => void }) {
    const t = useTranslations("office");
    const [open, setOpen] = useState(false);
    const [at, setAt] = useState({ rows: 1, cols: 1 });
    const grid = useRef<HTMLDivElement | null>(null);

    useEffect(() => {
        if (!open) return;
        setAt({ rows: 1, cols: 1 });
        // Into the grid once it is drawn, so the arrows move the corner.
        const frame = requestAnimationFrame(() =>
            grid.current?.querySelector<HTMLButtonElement>("button")?.focus()
        );
        return () => cancelAnimationFrame(frame);
    }, [open]);

    const pick = (rows: number, cols: number): void => {
        setOpen(false);
        onPick(rows, cols);
    };

    const onKey = (event: KeyboardEvent): void => {
        const moves: Record<string, readonly [number, number]> = {
            ArrowRight: [0, 1],
            ArrowLeft: [0, -1],
            ArrowDown: [1, 0],
            ArrowUp: [-1, 0]
        };
        const move = moves[event.key];
        if (!move) return;
        // The menu's own arrows walk a list; here they move the corner.
        event.preventDefault();
        event.stopPropagation();
        const rows = Math.min(PICK_ROWS, Math.max(1, at.rows + move[0]));
        const cols = Math.min(PICK_COLS, Math.max(1, at.cols + move[1]));
        setAt({ rows, cols });
        grid.current?.querySelector<HTMLButtonElement>(`[data-at="${rows}:${cols}"]`)?.focus();
    };

    return (
        <DropdownMenu open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    title={t("slides.table.insert")}
                >
                    <Table2 className="size-4 shrink-0" aria-hidden />
                    <span className="max-2xl:sr-only">{t("slides.table.insert")}</span>
                    <ChevronDown className="size-3 shrink-0" aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                align="start"
                className="p-2"
                onCloseAutoFocus={(event) => event.preventDefault()}
            >
                <div
                    ref={grid}
                    role="group"
                    aria-label={t("slides.table.size")}
                    className="grid gap-0.5"
                    style={{ gridTemplateColumns: `repeat(${PICK_COLS}, 1rem)` }}
                    onKeyDown={onKey}
                >
                    {Array.from({ length: PICK_ROWS }, (_, r) =>
                        Array.from({ length: PICK_COLS }, (_, c) => {
                            const rows = r + 1;
                            const cols = c + 1;
                            const lit = rows <= at.rows && cols <= at.cols;
                            const label = t("slides.table.sizeOf", { rows, cols });
                            return (
                                <button
                                    key={`${rows}:${cols}`}
                                    type="button"
                                    data-at={`${rows}:${cols}`}
                                    aria-label={label}
                                    tabIndex={rows === at.rows && cols === at.cols ? 0 : -1}
                                    onPointerEnter={() => setAt({ rows, cols })}
                                    onFocus={() => setAt({ rows, cols })}
                                    onClick={() => pick(rows, cols)}
                                    className={cn(
                                        "size-4 rounded-[2px] border transition-colors",
                                        lit
                                            ? "border-primary bg-primary/30"
                                            : "border-border bg-field"
                                    )}
                                />
                            );
                        })
                    )}
                </div>
                <p className="mt-2 text-center text-[12px] tabular-nums text-muted-foreground">
                    {t("slides.table.sizeOf", { rows: at.rows, cols: at.cols })}
                </p>
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

export function ChartMenu({ onPick }: { onPick: (kind: charts.ChartKind) => void }) {
    const t = useTranslations("office");
    return (
        <DropdownMenu>
            <DropdownMenuTrigger asChild>
                <Button
                    variant="ghost"
                    size="sm"
                    className="shrink-0"
                    title={t("slides.chart.insert")}
                >
                    <ChartColumn className="size-4 shrink-0" aria-hidden />
                    <span className="max-2xl:sr-only">{t("slides.chart.insert")}</span>
                    <ChevronDown className="size-3 shrink-0" aria-hidden />
                </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" onCloseAutoFocus={(event) => event.preventDefault()}>
                {charts.CHART_KINDS.map((kind) => {
                    const Icon = CHART_ICON[kind];
                    return (
                        <DropdownMenuItem key={kind} onSelect={() => onPick(kind)}>
                            <Icon className="size-4" />
                            {t(`slides.chart.kinds.${kind}`)}
                        </DropdownMenuItem>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}
