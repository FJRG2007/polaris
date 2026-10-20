"use client";

/**
 * Dashboards: pick one, and read its charts; make, rename and delete one, and
 * add, change, move and remove its charts.
 *
 * The page's frame paints at once and each chart fills its own card when its
 * figures arrive, from what this tab kept last time first. Changes show at
 * once and go back if the server refuses them.
 */

import { useCrmT } from "./i18n";
import { unwrap, messageOf } from "./call";
import { customDef } from "../model/fields";
import * as model from "../model/dashboards";
import * as actions from "../actions/dashboards";
import { hostUi } from "@polaris/app-host/client";
import { optionLabel, fieldLabel } from "./custom-fields";
import type { DashboardSummary } from "../lib/dashboards";
import type { DashboardsOpening } from "../actions/dashboards";
import { fieldOf, type CrmObject, type FieldDef } from "../model/objects";
import { useCallback, useMemo, useRef, useState } from "react";
import { blankWidget, WidgetDialog, type WidgetChoices } from "./widget-dialog";
import {
    BarRows,
    ChartColors,
    NumberFigure,
    PeriodLine,
    PointsTable,
    ShareRing,
    type ChartPoint
} from "./widget-charts";
import {
    ArrowLeft,
    ArrowRight,
    ChartColumn,
    ChevronDown,
    Check,
    MoreHorizontal,
    Pencil,
    Plus,
    Table2,
    Trash2
} from "lucide-react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
    EmptyState,
    Input,
    useToast
} from "@polaris/ui";

const REMEMBERED = "crm:dashboard";

function remembered(): string | null {
    try {
        return window.localStorage.getItem(REMEMBERED);
    } catch {
        return null;
    }
}

function remember(id: string): void {
    try {
        window.localStorage.setItem(REMEMBERED, id);
    } catch {
        // Blocked storage: the first dashboard opens next time.
    }
}

function Block({ className }: { className?: string }) {
    return <span aria-hidden className={cn("block animate-pulse rounded bg-muted", className)} />;
}

export function DashboardsScreen() {
    const t = useCrmT();
    const toast = useToast();
    const format = hostUi.displayFormat.useDisplayFormat();
    const [confirm, confirmElement] = hostUi.confirmDialog.useConfirm();
    const load = useCallback(
        () => unwrap(() => actions.openDashboardsAction(), t("errors.loadFailed")),
        [t]
    );
    const opening = hostUi.liveRead.useLiveRead<DashboardsOpening>({
        cacheKey: "crm:dashboards",
        load
    });
    const openingRef = useRef(opening);
    openingRef.current = opening;
    const data = opening.data;
    const list = useMemo(() => data?.dashboards ?? [], [data]);
    const [chosenId, setChosenId] = useState<string | null>(() => remembered());
    const current = list.find((one) => one.id === chosenId) ?? list[0] ?? null;
    const [naming, setNaming] = useState<
        { mode: "create" } | { mode: "rename"; dashboard: DashboardSummary } | null
    >(null);
    const [editing, setEditing] = useState<model.Widget | null>(null);
    const manage = Boolean(data?.canManage);

    const choices: WidgetChoices = useMemo(
        () => ({
            objects: Object.fromEntries(
                Object.entries(data?.objects ?? {}).map(([object, value]) => [
                    object,
                    { views: value!.views, custom: value!.fields.map(customDef) }
                ])
            ),
            defaultCurrency: format.preferences.currency
        }),
        [data, format.preferences.currency]
    );

    const put = (next: DashboardSummary) => {
        const opened = openingRef.current.data;
        if (!opened) return;
        openingRef.current.replace({
            ...opened,
            dashboards: opened.dashboards.map((one) => (one.id === next.id ? next : one))
        });
    };

    const pick = (id: string) => {
        setChosenId(id);
        remember(id);
    };

    /** Keep a dashboard's widgets: on screen now, back if refused. */
    const saveWidgets = (dashboard: DashboardSummary, widgets: model.Widget[]) => {
        put({ ...dashboard, widgets });
        unwrap(() => actions.saveWidgetsAction({ id: dashboard.id, widgets }), t("errors.generic"))
            .then(({ dashboard: saved }) => put(saved))
            .catch((caught) => {
                put(dashboard);
                toast.show({ title: t("dashboards.notSaved"), body: messageOf(caught) });
            });
    };

    const removeDashboard = async (dashboard: DashboardSummary) => {
        const ok = await confirm({
            title: t("dashboards.deleteTitle", { name: dashboard.name }),
            description: t("dashboards.deleteDescription"),
            confirmLabel: t("dashboards.delete"),
            danger: true
        });
        const opened = openingRef.current.data;
        if (!ok || !opened) return;
        openingRef.current.replace({
            ...opened,
            dashboards: opened.dashboards.filter((one) => one.id !== dashboard.id)
        });
        unwrap(() => actions.deleteDashboardAction({ id: dashboard.id }), t("errors.generic"))
            .then(() => toast.show({ title: t("dashboards.deleted", { name: dashboard.name }) }))
            .catch((caught) => {
                opening.refresh();
                toast.show({ title: t("dashboards.notSaved"), body: messageOf(caught) });
            });
    };

    const name = async (text: string) => {
        if (naming?.mode === "rename") {
            const { dashboard } = await unwrap(
                () => actions.renameDashboardAction({ id: naming.dashboard.id, name: text }),
                t("errors.generic")
            );
            put(dashboard);
        } else {
            const { dashboard } = await unwrap(
                () => actions.createDashboardAction({ name: text }),
                t("errors.generic")
            );
            const opened = openingRef.current.data;
            if (opened)
                openingRef.current.replace({
                    ...opened,
                    dashboards: [...opened.dashboards, dashboard]
                });
            pick(dashboard.id);
        }
    };

    const firstObject = (Object.keys(choices.objects)[0] ?? "companies") as CrmObject;

    let body: React.ReactNode;
    if (!data && opening.error) {
        body = (
            <EmptyState
                icon={<ChartColumn />}
                title={t("errors.loadFailed")}
                description={opening.error}
            />
        );
    } else if (!data) {
        body = (
            <div className="grid gap-3 md:grid-cols-2" aria-busy="true">
                {[0, 1, 2, 3].map((index) => (
                    <div key={index} className="h-48 rounded-lg border border-border bg-card p-4">
                        <Block className="h-4 w-32" />
                        <Block className="mt-6 h-20 w-full" />
                    </div>
                ))}
            </div>
        );
    } else if (!current) {
        body = (
            <EmptyState
                icon={<ChartColumn />}
                title={t("dashboards.emptyTitle")}
                description={manage ? t("dashboards.emptyBody") : t("dashboards.emptyReader")}
                action={
                    manage ? (
                        <Button onClick={() => setNaming({ mode: "create" })}>
                            <Plus className="size-4" />
                            {t("dashboards.create")}
                        </Button>
                    ) : null
                }
            />
        );
    } else if (current.widgets.length === 0) {
        body = (
            <EmptyState
                icon={<ChartColumn />}
                title={t("dashboards.noChartsTitle")}
                description={manage ? t("dashboards.noChartsBody") : t("dashboards.emptyReader")}
                action={
                    manage ? (
                        <Button onClick={() => setEditing(blankWidget(firstObject))}>
                            <Plus className="size-4" />
                            {t("dashboards.addChart")}
                        </Button>
                    ) : null
                }
            />
        );
    } else {
        body = (
            <div className="grid gap-3 md:grid-cols-2">
                {current.widgets.map((widget, index) => (
                    <WidgetCard
                        key={widget.id}
                        widget={widget}
                        canRead={Boolean(data.can[widget.object]?.read)}
                        custom={choices.objects[widget.object]?.custom ?? []}
                        manage={manage}
                        first={index === 0}
                        last={index === current.widgets.length - 1}
                        onEdit={() => setEditing(widget)}
                        onMove={(by) => {
                            const next = [...current.widgets];
                            const [moved] = next.splice(index, 1);
                            next.splice(index + by, 0, moved!);
                            saveWidgets(current, next);
                        }}
                        onRemove={() =>
                            saveWidgets(
                                current,
                                current.widgets.filter((one) => one.id !== widget.id)
                            )
                        }
                    />
                ))}
            </div>
        );
    }

    return (
        <div
            className="flex h-full min-h-0 flex-col gap-3 overflow-auto overscroll-contain"
            data-crm-ready
        >
            <ChartColors />
            <div className="flex min-w-0 flex-wrap items-center gap-2">
                <h1 className="text-[1.0625rem] font-semibold leading-tight tracking-tight">
                    {t("dashboards.title")}
                </h1>
                {list.length > 0 ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                className="min-w-0 max-w-full gap-1.5 px-2"
                                aria-label={t("dashboards.picker")}
                            >
                                <span className="truncate" title={current?.name}>
                                    {current?.name}
                                </span>
                                <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-64">
                            {list.map((one) => (
                                <DropdownMenuItem
                                    key={one.id}
                                    onSelect={() => pick(one.id)}
                                    className="gap-2"
                                >
                                    <span className="min-w-0 flex-1 truncate" title={one.name}>
                                        {one.name}
                                    </span>
                                    {one.id === current?.id ? (
                                        <Check className="size-3.5 shrink-0" />
                                    ) : null}
                                </DropdownMenuItem>
                            ))}
                            {manage ? (
                                <>
                                    <DropdownMenuSeparator />
                                    <DropdownMenuItem
                                        onSelect={() => setNaming({ mode: "create" })}
                                    >
                                        <Plus className="size-3.5" />
                                        {t("dashboards.create")}
                                    </DropdownMenuItem>
                                    {current ? (
                                        <>
                                            <DropdownMenuItem
                                                onSelect={() =>
                                                    setNaming({
                                                        mode: "rename",
                                                        dashboard: current
                                                    })
                                                }
                                            >
                                                <Pencil className="size-3.5" />
                                                {t("dashboards.rename")}
                                            </DropdownMenuItem>
                                            <DropdownMenuItem
                                                className="text-danger"
                                                onSelect={() => void removeDashboard(current)}
                                            >
                                                <Trash2 className="size-3.5" />
                                                {t("dashboards.delete")}
                                            </DropdownMenuItem>
                                        </>
                                    ) : null}
                                </>
                            ) : null}
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : null}
                <span className="mr-auto" />
                {manage && current ? (
                    <Button
                        size="sm"
                        onClick={() => setEditing(blankWidget(firstObject))}
                        disabled={current.widgets.length >= model.MAX_WIDGETS}
                        title={
                            current.widgets.length >= model.MAX_WIDGETS
                                ? t("dashboards.chartLimit", { max: model.MAX_WIDGETS })
                                : undefined
                        }
                    >
                        <Plus className="size-4" />
                        {t("dashboards.addChart")}
                    </Button>
                ) : null}
            </div>
            {body}
            {editing && current ? (
                <WidgetDialog
                    initial={editing}
                    existing={current.widgets.some((one) => one.id === editing.id)}
                    choices={choices}
                    onClose={() => setEditing(null)}
                    onSave={(widget) => {
                        setEditing(null);
                        const exists = current.widgets.some((one) => one.id === widget.id);
                        saveWidgets(
                            current,
                            exists
                                ? current.widgets.map((one) =>
                                      one.id === widget.id ? widget : one
                                  )
                                : [...current.widgets, widget]
                        );
                    }}
                />
            ) : null}
            {naming ? (
                <NameDialog
                    initial={naming.mode === "rename" ? naming.dashboard.name : ""}
                    taken={(text) =>
                        list.some(
                            (one) =>
                                one.name.toLocaleLowerCase() === text.toLocaleLowerCase() &&
                                (naming.mode !== "rename" || one.id !== naming.dashboard.id)
                        )
                    }
                    title={
                        naming.mode === "rename" ? t("dashboards.rename") : t("dashboards.create")
                    }
                    onSubmit={name}
                    onClose={() => setNaming(null)}
                />
            ) : null}
            {confirmElement}
        </div>
    );
}

/** A dashboard's name: new, or changed. */
function NameDialog({
    initial,
    title,
    taken,
    onSubmit,
    onClose
}: {
    initial: string;
    title: string;
    taken: (name: string) => boolean;
    /** Throws the sentence to show when the server refuses. */
    onSubmit: (name: string) => Promise<void>;
    onClose: () => void;
}) {
    const t = useCrmT();
    const [text, setText] = useState(initial);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const clean = text.trim().replace(/\s+/g, " ");
    const problem =
        clean.length > model.DASHBOARD_NAME_MAX
            ? t("dashboards.errors.name", { length: model.DASHBOARD_NAME_MAX })
            : clean && taken(clean)
              ? t("dashboards.errors.nameTaken")
              : null;
    const ready = Boolean(clean) && !problem && clean !== initial && !busy;
    const submit = () => {
        if (!ready) return;
        setBusy(true);
        onSubmit(clean)
            .then(onClose)
            .catch((caught) => setError(messageOf(caught)))
            .finally(() => setBusy(false));
    };
    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>{title}</DialogTitle>
                </DialogHeader>
                <label className="flex flex-col gap-1.5 text-[0.8125rem] font-medium">
                    {t("dashboards.name")} *
                    <Input
                        autoFocus
                        value={text}
                        placeholder={t("dashboards.namePlaceholder")}
                        aria-invalid={Boolean(problem) || undefined}
                        onChange={(event) => {
                            setText(event.target.value);
                            setError(null);
                        }}
                        onKeyDown={(event) => {
                            if (event.key === "Enter") submit();
                        }}
                    />
                </label>
                {problem || error ? (
                    <p className="text-[0.75rem] text-danger">{problem ?? error}</p>
                ) : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {t("dashboards.dialog.cancel")}
                    </Button>
                    <Button
                        aria-disabled={!ready || undefined}
                        className={!ready ? "opacity-50" : undefined}
                        onClick={submit}
                    >
                        {t("dashboards.dialog.save")}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

/** A widget's figures: kept from last time first, then read again. */
function useWidgetData(widget: model.Widget, enabled: boolean) {
    const t = useCrmT();
    const key = JSON.stringify({ ...widget, id: undefined, title: undefined, wide: undefined });
    const load = useCallback(
        () =>
            unwrap(() => actions.widgetDataAction({ widget }), t("errors.loadFailed")).then(
                (answer) => answer.data
            ),
        // The widget is read through its key: a new title does not count again.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [key, t]
    );
    return hostUi.liveRead.useLiveRead<model.WidgetData>({
        cacheKey: `crm:widget:${key}`,
        load,
        enabled
    });
}

function WidgetCard({
    widget,
    canRead,
    custom,
    manage,
    first,
    last,
    onEdit,
    onMove,
    onRemove
}: {
    widget: model.Widget;
    canRead: boolean;
    custom: readonly FieldDef[];
    manage: boolean;
    first: boolean;
    last: boolean;
    onEdit: () => void;
    onMove: (by: -1 | 1) => void;
    onRemove: () => void;
}) {
    const t = useCrmT();
    const format = hostUi.displayFormat.useDisplayFormat();
    const [asTable, setAsTable] = useState(false);
    const reading = useWidgetData(widget, canRead);
    const measured = widget.field ? fieldOf(widget.object, widget.field, custom) : undefined;
    const split = widget.groupBy ? fieldOf(widget.object, widget.groupBy, custom) : undefined;
    const title = widget.title || autoTitle(t, widget, measured, split);
    // An amount field counts in the one currency it was made with.
    const currency =
        widget.currency ?? (measured?.kind === "money" ? (measured.options?.[0] ?? null) : null);

    const formatValue = useMemo(() => {
        const number = new Intl.NumberFormat(format.preferences.language, {
            maximumFractionDigits: 2
        });
        if (currency) {
            try {
                const money = new Intl.NumberFormat(format.preferences.language, {
                    style: "currency",
                    currency,
                    maximumFractionDigits: 2
                });
                return (value: number) => money.format(value);
            } catch {
                // An unknown code: the amount with its code beside it.
                return (value: number) => `${number.format(value)} ${currency}`;
            }
        }
        return (value: number) => number.format(value);
    }, [format.preferences.language, currency]);

    const formatPeriod = useMemo(() => {
        const options: Intl.DateTimeFormatOptions =
            widget.granularity === "year"
                ? { year: "numeric", timeZone: "UTC" }
                : widget.granularity === "month" || widget.granularity === "quarter"
                  ? { year: "numeric", month: "short", timeZone: "UTC" }
                  : { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" };
        const dates = new Intl.DateTimeFormat(format.preferences.language, options);
        return (at: number) => {
            const date = new Date(at);
            if (widget.granularity === "quarter") {
                return t("dashboards.quarter", {
                    quarter: Math.floor(date.getUTCMonth() / 3) + 1,
                    year: date.getUTCFullYear()
                });
            }
            return dates.format(date);
        };
    }, [format.preferences.language, widget.granularity, t]);

    const points: ChartPoint[] = useMemo(() => {
        const answer = reading.data;
        if (!answer || answer.kind !== "groups") return [];
        const named = answer.points.map((point) => ({
            key: point.key,
            value: point.value,
            label: pointLabel(t, widget, split, point.key, point.label, formatPeriod)
        }));
        return answer.other !== null
            ? [...named, { key: "__other", label: t("dashboards.other"), value: answer.other }]
            : named;
    }, [reading.data, t, widget, split, formatPeriod]);

    let body: React.ReactNode;
    if (!canRead) {
        body = (
            <p className="text-[0.8125rem] text-muted-foreground">
                {t("errors.forbidden", { verb: "read", object: widget.object })}
            </p>
        );
    } else if (!reading.data && reading.error) {
        body = <p className="text-[0.8125rem] text-muted-foreground">{reading.error}</p>;
    } else if (!reading.data) {
        body = <Block className="h-24 w-full" />;
    } else if (reading.data.kind === "number") {
        body = <NumberFigure value={reading.data.value} format={formatValue} />;
    } else if (points.length === 0) {
        body = <p className="text-[0.8125rem] text-muted-foreground">{t("dashboards.nothing")}</p>;
    } else if (asTable) {
        body = (
            <PointsTable
                points={points}
                format={formatValue}
                groupHeading={split ? fieldLabel(t, widget.object, split) : ""}
                valueHeading={t(`dashboards.measures.${widget.measure}`)}
            />
        );
    } else if (widget.chart === "line") {
        body = (
            <PeriodLine
                points={points}
                format={formatValue}
                formatPeriod={(at) => formatPeriod(at)}
                label={title}
            />
        );
    } else if (widget.chart === "donut") {
        body = (
            <ShareRing
                points={points}
                format={formatValue}
                label={title}
                otherLabel={t("dashboards.other")}
            />
        );
    } else {
        body = <BarRows points={points} format={formatValue} label={title} />;
    }

    return (
        <section
            className={cn(
                "flex min-w-0 flex-col gap-3 rounded-lg border border-border bg-card p-4",
                widget.wide && "md:col-span-2"
            )}
            aria-label={title}
        >
            <div className="flex min-w-0 items-center gap-1">
                <h2 className="mr-auto min-w-0 truncate text-[0.875rem] font-medium" title={title}>
                    {title}
                </h2>
                {reading.data?.kind === "groups" && reading.data.capped ? (
                    <span
                        className="shrink-0 text-[0.75rem] text-muted-foreground"
                        title={t("dashboards.cappedHint")}
                    >
                        {t("dashboards.capped")}
                    </span>
                ) : null}
                {widget.chart !== "number" && canRead ? (
                    <Button
                        variant="ghost"
                        size="sm"
                        aria-pressed={asTable}
                        aria-label={t(asTable ? "dashboards.showChart" : "dashboards.showTable")}
                        title={t(asTable ? "dashboards.showChart" : "dashboards.showTable")}
                        onClick={() => setAsTable((before) => !before)}
                    >
                        {asTable ? (
                            <ChartColumn className="size-4" />
                        ) : (
                            <Table2 className="size-4" />
                        )}
                    </Button>
                ) : null}
                {manage ? (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                variant="ghost"
                                size="sm"
                                aria-label={t("dashboards.chartMenu", { name: title })}
                                title={t("dashboards.chartMenu", { name: title })}
                            >
                                <MoreHorizontal className="size-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                            <DropdownMenuItem onSelect={onEdit}>
                                <Pencil className="size-3.5" />
                                {t("dashboards.editChart")}
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={first} onSelect={() => onMove(-1)}>
                                <ArrowLeft className="size-3.5" />
                                {t("dashboards.moveEarlier")}
                            </DropdownMenuItem>
                            <DropdownMenuItem disabled={last} onSelect={() => onMove(1)}>
                                <ArrowRight className="size-3.5" />
                                {t("dashboards.moveLater")}
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem className="text-danger" onSelect={onRemove}>
                                <Trash2 className="size-3.5" />
                                {t("dashboards.removeChart")}
                            </DropdownMenuItem>
                        </DropdownMenuContent>
                    </DropdownMenu>
                ) : null}
            </div>
            {body}
        </section>
    );
}

type Translator = ReturnType<typeof useCrmT>;

/** "Count of companies by stage", when the chart was given no name. */
function autoTitle(
    t: Translator,
    widget: model.Widget,
    measured?: FieldDef,
    split?: FieldDef
): string {
    const what = measured
        ? t("dashboards.titleMeasure", {
              measure: t(`dashboards.measures.${widget.measure}`),
              field: fieldLabel(t, widget.object, measured)
          })
        : t("dashboards.titleCount", { object: t(`objects.${widget.object}.plural`) });
    return split
        ? t("dashboards.titleBy", { what, field: fieldLabel(t, widget.object, split) })
        : what;
}

function pointLabel(
    t: Translator,
    widget: model.Widget,
    split: FieldDef | undefined,
    key: string,
    named: string | null,
    formatPeriod: (at: number) => string
): string {
    if (widget.granularity) return formatPeriod(Date.parse(`${key}T00:00:00Z`));
    if (key === "") return t("dashboards.none");
    if (!split) return named ?? key;
    if (split.kind === "select") return optionLabel(t, widget.object, split, key);
    if (split.kind === "boolean") return t(key === "true" ? "values.yes" : "values.no");
    return named ?? t("dashboards.unknown");
}
