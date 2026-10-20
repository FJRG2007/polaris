"use client";

/**
 * Add or change one chart on a dashboard: which records, what is counted,
 * what it is split by, and how it is drawn. Every choice offers only what
 * fits the ones before it, and the widget is checked against the same schema
 * the server keeps it with before Save is offered.
 */

import { useState } from "react";
import { useCrmT } from "./i18n";
import { useViewName } from "./view-picker";
import { fieldLabel } from "./custom-fields";
import * as model from "../model/dashboards";
import type { ViewSummary } from "../model/views";
import { CRM_OBJECTS, fieldOf, type CrmObject, type FieldDef } from "../model/objects";
import {
    Button,
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    Input,
    SegmentedControl,
    Select,
    Switch,
    isDirty
} from "@polaris/ui";

const ALL = "__all";

export interface WidgetChoices {
    /** The kinds of record the reader may count, with their views and fields. */
    readonly objects: Partial<
        Record<CrmObject, { views: readonly ViewSummary[]; custom: readonly FieldDef[] }>
    >;
    readonly defaultCurrency: string;
}

export function blankWidget(object: CrmObject): model.Widget {
    return {
        id: crypto.randomUUID(),
        title: "",
        object,
        chart: "number",
        measure: "count",
        field: null,
        currency: null,
        groupBy: null,
        granularity: null,
        viewId: null,
        wide: false
    };
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
    return (
        <label className="flex min-w-0 flex-col gap-1.5 text-[0.8125rem] font-medium">
            {label}
            {children}
        </label>
    );
}

export function WidgetDialog({
    initial,
    existing = false,
    choices,
    onSave,
    onClose
}: {
    /** The widget changed; a new one when it is not on the dashboard yet. */
    initial: model.Widget;
    /** Whether `initial` is already on the dashboard, so saving it as is changes nothing. */
    existing?: boolean;
    choices: WidgetChoices;
    onSave: (widget: model.Widget) => void;
    onClose: () => void;
}) {
    const t = useCrmT();
    const viewName = useViewName();
    const [draft, setDraft] = useState<model.Widget>(initial);
    const objects = CRM_OBJECTS.filter((object) => choices.objects[object]);
    const current = choices.objects[draft.object];
    const custom = current?.custom ?? [];
    const measurable = model.measureFields(draft.object, custom, draft.measure);
    const splits = model.splitFields(draft.object, draft.chart, custom);
    const measured = draft.field ? fieldOf(draft.object, draft.field, custom) : undefined;
    const split = draft.groupBy ? fieldOf(draft.object, draft.groupBy, custom) : undefined;

    const parsed = model.widgetSchema.safeParse(draft);
    const ready =
        parsed.success &&
        model.readWidget(parsed.data, custom) !== null &&
        (!existing || isDirty(initial, draft));

    /** A change, with whatever no longer fits it put back to the first fit. */
    const change = (patch: Partial<model.Widget>) =>
        setDraft((before) => {
            const next = { ...before, ...patch };
            const fields = model.splitFields(
                next.object,
                next.chart,
                choices.objects[next.object]?.custom ?? []
            );
            if (next.chart === "number") {
                next.groupBy = null;
                next.granularity = null;
            } else if (!fields.some((field) => field.key === next.groupBy)) {
                next.groupBy = fields[0]?.key ?? null;
            }
            const by = next.groupBy
                ? fieldOf(next.object, next.groupBy, choices.objects[next.object]?.custom ?? [])
                : undefined;
            next.granularity = by && model.dated(by) ? (next.granularity ?? "month") : null;
            if (!model.measuresOf(next.object).includes(next.measure)) next.measure = "sum";
            const numbers = model.measureFields(
                next.object,
                choices.objects[next.object]?.custom ?? [],
                next.measure
            );
            if (next.measure === "count") {
                next.field = null;
            } else if (!numbers.some((field) => field.key === next.field)) {
                next.field = numbers[0]?.key ?? null;
            }
            const counted = next.field
                ? fieldOf(next.object, next.field, choices.objects[next.object]?.custom ?? [])
                : undefined;
            next.currency =
                counted?.kind === "currency" ? (next.currency ?? choices.defaultCurrency) : null;
            if (next.object !== before.object) next.viewId = null;
            return next;
        });

    const reason = !ready
        ? draft.measure !== "count" && measurable.length === 0
            ? t("dashboards.dialog.noNumbers")
            : draft.chart !== "number" && splits.length === 0
              ? t("dashboards.dialog.noSplits")
              : t("dashboards.dialog.incomplete")
        : null;

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-lg">
                <DialogHeader>
                    <DialogTitle>{t("dashboards.dialog.title")}</DialogTitle>
                    <DialogDescription>{t("dashboards.dialog.description")}</DialogDescription>
                </DialogHeader>
                <div className="flex flex-col gap-3">
                    <Labeled label={t("dashboards.dialog.name")}>
                        <Input
                            value={draft.title}
                            maxLength={model.WIDGET_TITLE_MAX}
                            placeholder={t("dashboards.dialog.namePlaceholder")}
                            onChange={(event) => change({ title: event.target.value })}
                        />
                    </Labeled>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Labeled label={t("dashboards.dialog.object")}>
                            <Select
                                aria-label={t("dashboards.dialog.object")}
                                value={draft.object}
                                onValueChange={(object) => change({ object: object as CrmObject })}
                                options={objects.map((object) => ({
                                    value: object,
                                    label: t(`objects.${object}.plural`)
                                }))}
                            />
                        </Labeled>
                        <Labeled label={t("dashboards.dialog.view")}>
                            <Select
                                aria-label={t("dashboards.dialog.view")}
                                value={draft.viewId ?? ALL}
                                onValueChange={(value) =>
                                    change({ viewId: value === ALL ? null : value })
                                }
                                options={[
                                    { value: ALL, label: t("dashboards.dialog.allRecords") },
                                    ...(current?.views ?? []).map((view) => ({
                                        value: view.id,
                                        label: viewName(view)
                                    }))
                                ]}
                            />
                        </Labeled>
                    </div>
                    <Labeled label={t("dashboards.dialog.chart")}>
                        <SegmentedControl
                            size="sm"
                            aria-label={t("dashboards.dialog.chart")}
                            value={draft.chart}
                            onValueChange={(chart) => change({ chart: chart as model.ChartKind })}
                            options={model.CHART_KINDS.map((chart) => ({
                                value: chart,
                                label: t(`dashboards.charts.${chart}`)
                            }))}
                        />
                    </Labeled>
                    <div className="grid gap-3 sm:grid-cols-2">
                        <Labeled label={t("dashboards.dialog.measure")}>
                            <Select
                                aria-label={t("dashboards.dialog.measure")}
                                value={draft.measure}
                                onValueChange={(measure) =>
                                    change({ measure: measure as model.Measure })
                                }
                                options={model.measuresOf(draft.object).map((measure) => ({
                                    value: measure,
                                    label: t(`dashboards.measures.${measure}`)
                                }))}
                            />
                        </Labeled>
                        {draft.measure !== "count" ? (
                            <Labeled label={t("dashboards.dialog.field")}>
                                <Select
                                    aria-label={t("dashboards.dialog.field")}
                                    value={draft.field ?? ""}
                                    onValueChange={(field) => change({ field })}
                                    options={measurable.map((field) => ({
                                        value: field.key,
                                        label: fieldLabel(t, draft.object, field)
                                    }))}
                                />
                            </Labeled>
                        ) : null}
                        {measured?.kind === "currency" ? (
                            <Labeled label={t("dashboards.dialog.currency")}>
                                <Input
                                    value={draft.currency ?? ""}
                                    maxLength={3}
                                    aria-invalid={
                                        !/^[A-Z]{3}$/.test(draft.currency ?? "") || undefined
                                    }
                                    onChange={(event) =>
                                        change({
                                            currency: event.target.value.trim().toUpperCase()
                                        })
                                    }
                                />
                            </Labeled>
                        ) : null}
                    </div>
                    {draft.chart !== "number" ? (
                        <div className="grid gap-3 sm:grid-cols-2">
                            <Labeled label={t("dashboards.dialog.groupBy")}>
                                <Select
                                    aria-label={t("dashboards.dialog.groupBy")}
                                    value={draft.groupBy ?? ""}
                                    onValueChange={(groupBy) =>
                                        change({ groupBy, granularity: null })
                                    }
                                    options={splits.map((field) => ({
                                        value: field.key,
                                        label: fieldLabel(t, draft.object, field)
                                    }))}
                                />
                            </Labeled>
                            {split && model.dated(split) ? (
                                <Labeled label={t("dashboards.dialog.granularity")}>
                                    <Select
                                        aria-label={t("dashboards.dialog.granularity")}
                                        value={draft.granularity ?? "month"}
                                        onValueChange={(granularity) =>
                                            change({
                                                granularity: granularity as model.Granularity
                                            })
                                        }
                                        options={model.GRANULARITIES.map((granularity) => ({
                                            value: granularity,
                                            label: t(`dashboards.granularities.${granularity}`)
                                        }))}
                                    />
                                </Labeled>
                            ) : null}
                        </div>
                    ) : null}
                    {draft.measure === "weighted" ? (
                        <p className="text-[0.75rem] text-muted-foreground">
                            {t("dashboards.dialog.weightedHint")}
                        </p>
                    ) : null}
                    <label className="flex items-center gap-2 text-[0.8125rem]">
                        <Switch
                            checked={draft.wide}
                            onChange={(wide) => change({ wide })}
                            aria-label={t("dashboards.dialog.wide")}
                        />
                        {t("dashboards.dialog.wide")}
                    </label>
                    {reason ? (
                        <p className="text-[0.75rem] text-muted-foreground">{reason}</p>
                    ) : null}
                </div>
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("dashboards.dialog.cancel")}
                    </Button>
                    <Button
                        aria-disabled={!ready || undefined}
                        onClick={() => {
                            if (ready && parsed.success) onSave(parsed.data);
                        }}
                        className={!ready ? "opacity-50" : undefined}
                    >
                        {t("dashboards.dialog.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
