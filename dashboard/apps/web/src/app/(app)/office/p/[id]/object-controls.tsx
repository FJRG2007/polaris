"use client";

/**
 * The format bar's controls for a table and for a chart.
 *
 * A table: rows and columns added and taken out beside the cell being typed
 * in (or the first one), the header row and banding switched, the header's
 * fill and the borders' colour and weight - PowerPoint's Table Design ribbon,
 * cut to what a slide needs. A chart: its data, its kind, its key and its
 * value labels - Google Slides' chart menu.
 */

import * as deck from "@/lib/office/deck";
import * as tables from "@/lib/office/slide-table";
import * as charts from "@/lib/office/slide-chart";
import { ToolbarButton } from "@/components/rich-text/toolbar";
import { Choice, FILL_COLORS, MenuButton } from "./format-bar";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { DropdownMenuItem, DropdownMenuSeparator } from "@polaris/ui";
import { SwatchMenu } from "@/components/rich-text/formatting-toolbar";
import {
    AreaChart,
    BarChart3,
    BarChartHorizontal,
    Columns3,
    LineChart,
    PaintBucket,
    PenLine,
    PieChart,
    Rows3,
    Sheet,
    SeparatorHorizontal,
    Tag,
    TableProperties,
    Trash2
} from "lucide-react";
import type { ComponentType } from "react";

export const CHART_ICON: Readonly<Record<charts.ChartKind, ComponentType<{ className?: string }>>> =
    {
        column: BarChart3,
        bar: BarChartHorizontal,
        line: LineChart,
        area: AreaChart,
        pie: PieChart
    };

function Divider() {
    return <span aria-hidden className="mx-1 h-5 w-px shrink-0 bg-border" />;
}

export function TableControls({
    box,
    cell,
    onTable,
    onPatch
}: {
    box: deck.Box;
    /** The cell rows and columns are added beside. */
    cell: tables.CellAt;
    onTable: (edit: (table: tables.SlideTable) => tables.SlideTable) => void;
    onPatch: (patch: Partial<Pick<deck.Box, "fill" | "stroke" | "strokeWidth">>) => void;
}) {
    const t = useTranslations("office");
    const table = box.table;
    if (!table) return null;
    const at = tables.clampCell(table, cell);
    const full = (count: number): boolean => count >= tables.TABLE_MAX;
    const strokePoints = deck.pointsOf(box.strokeWidth);
    return (
        <>
            <Divider />
            <MenuButton
                label={t("slides.table.rowsAndColumns")}
                menu={
                    <>
                        <DropdownMenuItem
                            disabled={full(tables.rowCount(table))}
                            onSelect={() => onTable((one) => tables.insertRow(one, at.row))}
                        >
                            <Rows3 aria-hidden />
                            {t("slides.table.rowAbove")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={full(tables.rowCount(table))}
                            onSelect={() => onTable((one) => tables.insertRow(one, at.row + 1))}
                        >
                            <Rows3 aria-hidden />
                            {t("slides.table.rowBelow")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={full(tables.colCount(table))}
                            onSelect={() => onTable((one) => tables.insertCol(one, at.col))}
                        >
                            <Columns3 aria-hidden />
                            {t("slides.table.columnLeft")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={full(tables.colCount(table))}
                            onSelect={() => onTable((one) => tables.insertCol(one, at.col + 1))}
                        >
                            <Columns3 aria-hidden />
                            {t("slides.table.columnRight")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                            disabled={tables.rowCount(table) <= 1}
                            onSelect={() => onTable((one) => tables.removeRow(one, at.row))}
                        >
                            <Trash2 aria-hidden />
                            {t("slides.table.deleteRow")}
                        </DropdownMenuItem>
                        <DropdownMenuItem
                            disabled={tables.colCount(table) <= 1}
                            onSelect={() => onTable((one) => tables.removeCol(one, at.col))}
                        >
                            <Trash2 aria-hidden />
                            {t("slides.table.deleteColumn")}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <Choice
                            chosen={table.header}
                            onSelect={() => onTable((one) => ({ ...one, header: !one.header }))}
                        >
                            {t("slides.table.headerRow")}
                        </Choice>
                        <Choice
                            chosen={table.banded}
                            onSelect={() => onTable((one) => ({ ...one, banded: !one.banded }))}
                        >
                            {t("slides.table.bandedRows")}
                        </Choice>
                    </>
                }
            >
                <TableProperties className="size-4" />
            </MenuButton>
            <SwatchMenu
                label={t("slides.table.headerColor")}
                noneLabel={t("slides.format.noFill")}
                icon={<PaintBucket className="size-4" />}
                swatches={FILL_COLORS}
                current={box.fill === "transparent" ? "" : box.fill}
                disabled={false}
                onPick={(color) => onPatch({ fill: color ?? "transparent" })}
            />
            <SwatchMenu
                label={t("slides.format.border")}
                noneLabel={t("slides.format.noBorder")}
                icon={<PenLine className="size-4" />}
                swatches={FILL_COLORS}
                current={box.stroke}
                disabled={false}
                onPick={(color) => onPatch({ stroke: color ?? "" })}
            />
            <MenuButton
                label={t("slides.format.borderWeight")}
                menu={deck.STROKE_POINTS.map((one) => (
                    <Choice
                        key={one}
                        chosen={one === strokePoints}
                        onSelect={() =>
                            onPatch({
                                strokeWidth: deck.fractionOfPoints(one),
                                ...(box.stroke ? {} : { stroke: deck.TABLE_BORDER })
                            })
                        }
                    >
                        <span
                            aria-hidden
                            className="w-8 shrink-0 rounded-full bg-foreground"
                            style={{ height: Math.max(1, Math.min(8, one)) }}
                        />
                        {t("slides.format.points", { points: one })}
                    </Choice>
                ))}
            >
                <SeparatorHorizontal className="size-4" />
            </MenuButton>
        </>
    );
}

export function ChartControls({
    box,
    onChart,
    onEditData
}: {
    box: deck.Box;
    onChart: (chart: charts.SlideChart) => void;
    onEditData: () => void;
}) {
    const t = useTranslations("office");
    const chart = box.chart;
    if (!chart) return null;
    const Icon = CHART_ICON[chart.kind];
    return (
        <>
            <Divider />
            <ToolbarButton label={t("slides.chart.editData")} onClick={onEditData}>
                <Sheet className="size-4" />
            </ToolbarButton>
            <MenuButton
                label={t("slides.chart.kind")}
                menu={charts.CHART_KINDS.map((one) => {
                    const KindIcon = CHART_ICON[one];
                    return (
                        <Choice
                            key={one}
                            chosen={chart.kind === one}
                            onSelect={() => onChart({ ...chart, kind: one })}
                        >
                            <KindIcon aria-hidden />
                            {t(`slides.chart.kinds.${one}`)}
                        </Choice>
                    );
                })}
            >
                <Icon className="size-4" />
            </MenuButton>
            <ToolbarButton
                label={t("slides.chart.legend")}
                active={chart.legend}
                onClick={() => onChart({ ...chart, legend: !chart.legend })}
            >
                <Rows3 className="size-4" />
            </ToolbarButton>
            <ToolbarButton
                label={t("slides.chart.labels")}
                active={chart.labels}
                onClick={() => onChart({ ...chart, labels: !chart.labels })}
            >
                <Tag className="size-4" />
            </ToolbarButton>
        </>
    );
}
