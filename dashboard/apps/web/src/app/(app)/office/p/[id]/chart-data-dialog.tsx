"use client";

/**
 * A chart's numbers, edited as the small sheet PowerPoint and Google Slides
 * open behind one: categories down the side, a column per series, the kind and
 * its two switches above, and the chart itself redrawn as the numbers change.
 *
 * Nothing reaches the deck until Save, so a half-typed sheet is never what
 * everybody else sees, and the whole edit is one step undo takes back. A cell
 * that is not a number is marked as it is typed, and Save waits for it.
 */

import * as deck from "@/lib/office/deck";
import { ChartArt } from "./slide-objects";
import * as charts from "@/lib/office/slide-chart";
import { useTranslations } from "@/components/i18n/i18n-provider";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Switch
} from "@polaris/ui";
import { Plus, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

/** The sheet as typed: every value still the words somebody typed. */
interface Sheet {
    readonly kind: charts.ChartKind;
    readonly categories: readonly string[];
    readonly names: readonly string[];
    /** `values[category][series]`, as typed. */
    readonly values: readonly (readonly string[])[];
    readonly legend: boolean;
    readonly labels: boolean;
}

function sheetOf(chart: charts.SlideChart): Sheet {
    return {
        kind: chart.kind,
        categories: [...chart.categories],
        names: chart.series.map((one) => one.name),
        values: chart.categories.map((_, c) =>
            chart.series.map((one) => String(one.values[c] ?? 0))
        ),
        legend: chart.legend,
        labels: chart.labels
    };
}

/** The chart a sheet makes, or null while a value in it is not a number. */
function chartOf(sheet: Sheet): charts.SlideChart | null {
    const parsed = sheet.values.map((row) => row.map(charts.parseValue));
    if (parsed.some((row) => row.some((value) => value === null))) return null;
    return {
        kind: sheet.kind,
        categories: sheet.categories.map((one) => one.trim()),
        series: sheet.names.map((name, s) => ({
            name: name.trim(),
            values: parsed.map((row) => row[s] ?? 0)
        })),
        legend: sheet.legend,
        labels: sheet.labels
    };
}

export function ChartDataDialog({
    chart,
    look,
    font,
    open,
    onOpenChange,
    onSave
}: {
    chart: charts.SlideChart;
    look: deck.SlideLook;
    /** The face the chart's words are set in, for the preview. */
    font: string;
    open: boolean;
    onOpenChange: (open: boolean) => void;
    onSave: (chart: charts.SlideChart) => void;
}) {
    const t = useTranslations("office");
    const [sheet, setSheet] = useState<Sheet>(() => sheetOf(chart));
    // Opened again, it starts from the chart as it is now - somebody else may
    // have changed it since.
    useEffect(() => {
        if (open) setSheet(sheetOf(chart));
    }, [open]);

    const made = useMemo(() => chartOf(sheet), [sheet]);
    const unchanged =
        made !== null && JSON.stringify(made) === JSON.stringify(charts.readChart(chart));
    const preview: deck.Box | null = made
        ? {
              ...deck.newChartBox("preview", made),
              x: 0,
              y: 0,
              w: 1,
              h: 1,
              size: deck.fractionOfPoints(22),
              font
          }
        : null;

    const set = (patch: Partial<Sheet>): void => setSheet((held) => ({ ...held, ...patch }));
    const setValue = (c: number, s: number, typed: string): void =>
        setSheet((held) => ({
            ...held,
            values: held.values.map((row, r) =>
                r === c ? row.map((cell, k) => (k === s ? typed : cell)) : row
            )
        }));
    const addCategory = (): void =>
        setSheet((held) =>
            held.categories.length >= charts.CATEGORIES_MAX
                ? held
                : {
                      ...held,
                      categories: [
                          ...held.categories,
                          t("slides.chart.categoryN", { number: held.categories.length + 1 })
                      ],
                      values: [...held.values, held.names.map(() => "0")]
                  }
        );
    const removeCategory = (c: number): void =>
        setSheet((held) =>
            held.categories.length <= 1
                ? held
                : {
                      ...held,
                      categories: held.categories.filter((_, at) => at !== c),
                      values: held.values.filter((_, at) => at !== c)
                  }
        );
    const addSeries = (): void =>
        setSheet((held) =>
            held.names.length >= charts.SERIES_MAX
                ? held
                : {
                      ...held,
                      names: [
                          ...held.names,
                          t("slides.chart.seriesN", { number: held.names.length + 1 })
                      ],
                      values: held.values.map((row) => [...row, "0"])
                  }
        );
    const removeSeries = (s: number): void =>
        setSheet((held) =>
            held.names.length <= 1
                ? held
                : {
                      ...held,
                      names: held.names.filter((_, at) => at !== s),
                      values: held.values.map((row) => row.filter((_, at) => at !== s))
                  }
        );

    const kinds = charts.CHART_KINDS.map((one) => ({
        value: one,
        label: t(`slides.chart.kinds.${one}`)
    }));

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="w-[min(56rem,95vw)] max-w-[min(56rem,95vw)]">
                <DialogHeader className="pr-8">
                    <DialogTitle>{t("slides.chart.dataTitle")}</DialogTitle>
                    <DialogDescription>{t("slides.chart.dataHint")}</DialogDescription>
                </DialogHeader>
                <div className="mt-4 flex flex-col gap-4">
                    <SegmentedControl
                        aria-label={t("slides.chart.kind")}
                        value={sheet.kind}
                        onValueChange={(kind) => set({ kind })}
                        options={kinds}
                        size="sm"
                    />
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[13px]">
                        <label className="flex items-center gap-2">
                            <Switch
                                checked={sheet.legend}
                                onChange={(legend) => set({ legend })}
                                aria-label={t("slides.chart.legend")}
                            />
                            {t("slides.chart.legend")}
                        </label>
                        <label className="flex items-center gap-2">
                            <Switch
                                checked={sheet.labels}
                                onChange={(labels) => set({ labels })}
                                aria-label={t("slides.chart.labels")}
                            />
                            {t("slides.chart.labels")}
                        </label>
                        {sheet.kind === "pie" && sheet.names.length > 1 ? (
                            <span className="text-muted-foreground">
                                {t("slides.chart.pieFirstSeries")}
                            </span>
                        ) : null}
                    </div>
                    <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
                        <div className="max-h-[45vh] min-w-0 overflow-auto overscroll-contain rounded-md border border-border">
                            <table className="w-max min-w-full border-collapse text-[13px]">
                                <thead>
                                    <tr>
                                        <th className="sticky left-0 z-10 bg-card p-1.5 text-left">
                                            {t("slides.chart.category")}
                                        </th>
                                        {sheet.names.map((name, s) => (
                                            <th key={s} className="p-1.5 text-left">
                                                <div className="flex items-center gap-1">
                                                    <span
                                                        aria-hidden
                                                        className="size-2.5 shrink-0 rounded-sm"
                                                        style={{
                                                            backgroundColor: charts.seriesColor(
                                                                s,
                                                                look.background
                                                            )
                                                        }}
                                                    />
                                                    <Input
                                                        value={name}
                                                        maxLength={charts.NAME_MAX}
                                                        aria-label={t("slides.chart.seriesName", {
                                                            number: s + 1
                                                        })}
                                                        onChange={(event) =>
                                                            set({
                                                                names: sheet.names.map((one, at) =>
                                                                    at === s
                                                                        ? event.target.value
                                                                        : one
                                                                )
                                                            })
                                                        }
                                                        className="w-28 normal-case tracking-normal"
                                                    />
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        disabled={sheet.names.length <= 1}
                                                        aria-label={t("slides.chart.removeSeries")}
                                                        title={t("slides.chart.removeSeries")}
                                                        onClick={() => removeSeries(s)}
                                                    >
                                                        <X className="size-4" aria-hidden />
                                                    </Button>
                                                </div>
                                            </th>
                                        ))}
                                        <th className="p-1.5">
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                disabled={sheet.names.length >= charts.SERIES_MAX}
                                                onClick={addSeries}
                                                className="normal-case tracking-normal"
                                            >
                                                <Plus className="size-4" aria-hidden />
                                                {t("slides.chart.addSeries")}
                                            </Button>
                                        </th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {sheet.categories.map((category, c) => (
                                        <tr key={c}>
                                            <td className="sticky left-0 z-10 bg-card p-1.5">
                                                <div className="flex items-center gap-1">
                                                    <Button
                                                        variant="ghost"
                                                        size="icon"
                                                        disabled={sheet.categories.length <= 1}
                                                        aria-label={t(
                                                            "slides.chart.removeCategory"
                                                        )}
                                                        title={t("slides.chart.removeCategory")}
                                                        onClick={() => removeCategory(c)}
                                                    >
                                                        <X className="size-4" aria-hidden />
                                                    </Button>
                                                    <Input
                                                        value={category}
                                                        maxLength={charts.NAME_MAX}
                                                        aria-label={t("slides.chart.categoryName", {
                                                            number: c + 1
                                                        })}
                                                        onChange={(event) =>
                                                            set({
                                                                categories: sheet.categories.map(
                                                                    (one, at) =>
                                                                        at === c
                                                                            ? event.target.value
                                                                            : one
                                                                )
                                                            })
                                                        }
                                                        className="w-28"
                                                    />
                                                </div>
                                            </td>
                                            {sheet.names.map((_, s) => {
                                                const typed = sheet.values[c]?.[s] ?? "";
                                                const wrong = charts.parseValue(typed) === null;
                                                return (
                                                    <td key={s} className="p-1.5">
                                                        <Input
                                                            value={typed}
                                                            inputMode="decimal"
                                                            aria-invalid={wrong}
                                                            aria-label={t("slides.chart.valueOf", {
                                                                category: category || c + 1,
                                                                series: sheet.names[s] || s + 1
                                                            })}
                                                            title={
                                                                wrong
                                                                    ? t("slides.chart.notANumber")
                                                                    : undefined
                                                            }
                                                            onChange={(event) =>
                                                                setValue(c, s, event.target.value)
                                                            }
                                                            className={cn(
                                                                "w-28 text-right tabular-nums",
                                                                wrong && "border-danger"
                                                            )}
                                                        />
                                                    </td>
                                                );
                                            })}
                                            <td />
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                            <div className="sticky left-0 p-1.5">
                                <Button
                                    variant="ghost"
                                    size="sm"
                                    disabled={sheet.categories.length >= charts.CATEGORIES_MAX}
                                    onClick={addCategory}
                                >
                                    <Plus className="size-4" aria-hidden />
                                    {t("slides.chart.addCategory")}
                                </Button>
                            </div>
                        </div>
                        <div
                            className="relative aspect-video w-full overflow-hidden rounded-md border border-border [container-type:size]"
                            style={{ backgroundColor: look.background }}
                        >
                            {preview ? (
                                <ChartArt box={preview} look={look} />
                            ) : (
                                <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-[13px] text-danger">
                                    {t("slides.chart.fixTheNumbers")}
                                </p>
                            )}
                        </div>
                    </div>
                </div>
                <DialogFooter className="mt-5">
                    <Button variant="secondary" onClick={() => onOpenChange(false)}>
                        {t("slides.chart.cancel")}
                    </Button>
                    <Button
                        disabled={!made || unchanged}
                        onClick={() => {
                            if (!made) return;
                            onSave(made);
                            onOpenChange(false);
                        }}
                    >
                        {t("slides.chart.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
