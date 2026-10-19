"use client";

/**
 * The sales forecast: per coming month or quarter, the deals due, what is won,
 * what is still open, and what is expected once each open deal is weighed by
 * its stage's odds; then the open deals already past their close date and the
 * ones with none. Amounts read in one currency at a time.
 *
 * The header and the controls paint at once; the figures fill in when they
 * arrive, from what this tab kept last time first.
 */

import Link from "next/link";
import { useCrmT } from "./i18n";
import { unwrap, messageOf } from "./call";
import * as model from "../model/forecast";
import { fieldOf } from "../model/objects";
import { ChartColors } from "./widget-charts";
import { optionLabel } from "./custom-fields";
import { StageFlowPanel } from "./stage-flow-panel";
import * as actions from "../actions/forecast";
import { hostUi } from "@polaris/app-host/client";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ForecastReading } from "../actions/forecast";
import { Percent, Target, TrendingUp } from "lucide-react";
import {
    Button,
    cn,
    Dialog,
    DialogContent,
    DialogFooter,
    DialogHeader,
    DialogTitle,
    EmptyState,
    Input,
    SegmentedControl,
    Select,
    useToast
} from "@polaris/ui";

const REMEMBERED = "crm:forecast";
const SPANS = [3, 6, 12] as const;

interface Choice {
    granularity: model.ForecastGranularity;
    periods: number;
    mine: boolean;
}

const FIRST_CHOICE: Choice = { granularity: "month", periods: 6, mine: false };

function rememberedChoice(): Choice {
    try {
        const raw = window.localStorage.getItem(REMEMBERED);
        const parsed = model.forecastInputSchema.safeParse(raw ? JSON.parse(raw) : null);
        return parsed.success ? parsed.data : FIRST_CHOICE;
    } catch {
        return FIRST_CHOICE;
    }
}

function rememberChoice(choice: Choice): void {
    try {
        window.localStorage.setItem(REMEMBERED, JSON.stringify(choice));
    } catch {
        // Blocked storage: the first choice opens next time.
    }
}

function Block({ className }: { className?: string }) {
    return <span aria-hidden className={cn("block animate-pulse rounded bg-muted", className)} />;
}

export function ForecastScreen() {
    const t = useCrmT();
    const format = hostUi.displayFormat.useDisplayFormat();
    const locale = format.preferences.language;
    // The server draws the first choice; the one this browser kept is read
    // once mounted, before anything is asked for, so the two never disagree.
    const [choice, setChoiceState] = useState<Choice>(FIRST_CHOICE);
    const [mounted, setMounted] = useState(false);
    useEffect(() => {
        setChoiceState(rememberedChoice());
        setMounted(true);
    }, []);
    const setChoice = (next: Partial<Choice>) => {
        const merged = { ...choice, ...next };
        setChoiceState(merged);
        rememberChoice(merged);
    };
    const [currencyPick, setCurrencyPick] = useState<string | null>(null);
    const [editingOdds, setEditingOdds] = useState(false);

    const load = useCallback(
        () => unwrap(() => actions.forecastAction(choice), t("errors.loadFailed")),
        [choice, t]
    );
    const reading = hostUi.liveRead.useLiveRead<ForecastReading>({
        cacheKey: `crm:forecast:${choice.granularity}:${choice.periods}:${choice.mine ? "mine" : "all"}`,
        load,
        enabled: mounted
    });
    const data = reading.data?.forecast ?? null;
    const currencies = data?.currencies ?? [];
    const currency =
        currencyPick && currencies.includes(currencyPick)
            ? currencyPick
            : (currencies.find((code) => code === format.preferences.currency) ??
              currencies[0] ??
              format.preferences.currency);

    const money = useMemo(() => {
        try {
            const formatter = new Intl.NumberFormat(locale, {
                style: "currency",
                currency,
                maximumFractionDigits: 0
            });
            return (value: number) => formatter.format(value);
        } catch {
            const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
            return (value: number) => `${number.format(value)} ${currency}`;
        }
    }, [locale, currency]);

    const periodName = useMemo(() => {
        const months = new Intl.DateTimeFormat(locale, {
            year: "numeric",
            month: "short",
            timeZone: "UTC"
        });
        return (key: string) => {
            if (key === "pastDue") return t("forecast.pastDue");
            if (key === "undated") return t("forecast.undated");
            const date = new Date(`${key}T00:00:00Z`);
            if (data?.granularity === "quarter") {
                return t("forecast.quarter", {
                    quarter: Math.floor(date.getUTCMonth() / 3) + 1,
                    year: date.getUTCFullYear()
                });
            }
            return months.format(date);
        };
    }, [locale, data?.granularity, t]);

    const total = data ? model.totalOf(data.periods, currency) : null;
    const due = data ? data.periods.reduce((sum, period) => sum + period.deals, 0) : 0;
    const anything = data ? due + data.pastDue.deals + data.undated.deals > 0 : false;

    let body: React.ReactNode;
    if (!data && reading.error) {
        body = (
            <EmptyState
                icon={<TrendingUp />}
                title={t("errors.loadFailed")}
                description={reading.error}
            />
        );
    } else if (!data || !total) {
        body = (
            <div className="flex flex-col gap-3" aria-busy="true">
                <div className="grid gap-3 sm:grid-cols-3">
                    {[0, 1, 2].map((index) => (
                        <div key={index} className="rounded-lg border border-border bg-card p-4">
                            <Block className="h-3 w-20" />
                            <Block className="mt-3 h-7 w-32" />
                        </div>
                    ))}
                </div>
                <div className="rounded-lg border border-border bg-card p-4">
                    {[0, 1, 2, 3, 4].map((index) => (
                        <Block key={index} className="mb-3 h-4 w-full" />
                    ))}
                </div>
            </div>
        );
    } else if (!anything) {
        body = (
            <EmptyState
                icon={<TrendingUp />}
                title={t("forecast.emptyTitle")}
                description={t("forecast.emptyBody")}
                action={
                    <Button asChild variant="outline">
                        <Link href="/crm/opportunities">{t("forecast.openList")}</Link>
                    </Button>
                }
            />
        );
    } else {
        const peak = Math.max(
            0,
            ...data.periods.map((period) => period.money[currency]?.expected ?? 0)
        );
        const extra = [data.pastDue, data.undated].filter((period) => period.deals > 0);
        body = (
            <div className="crm-viz flex flex-col gap-3">
                {data.capped ? (
                    <p className="rounded-md border border-border bg-muted/40 px-3 py-2 text-[0.8125rem]">
                        {t("forecast.capped")}
                    </p>
                ) : null}
                <div className="grid gap-3 sm:grid-cols-3">
                    <Figure
                        label={t("forecast.expected")}
                        value={money(total.expected)}
                        hint={t("forecast.expectedHint")}
                    />
                    <Figure label={t("forecast.won")} value={money(total.won)} />
                    <Figure label={t("forecast.open")} value={money(total.open)} />
                </div>
                <div className="overflow-x-auto rounded-lg border border-border bg-card">
                    <table className="w-full min-w-[34rem] text-[0.8125rem]">
                        <caption className="sr-only">{t("forecast.tableLabel")}</caption>
                        <thead className="text-left text-muted-foreground">
                            <tr className="border-b border-border">
                                <th scope="col" className="sticky left-0 bg-card px-3 py-2 font-medium">
                                    {t("forecast.period")}
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    {t("forecast.deals")}
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    {t("forecast.won")}
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    {t("forecast.open")}
                                </th>
                                <th scope="col" className="px-3 py-2 text-right font-medium">
                                    {t("forecast.expected")}
                                </th>
                                <th scope="col" className="w-[28%] px-3 py-2">
                                    <span className="sr-only">{t("forecast.chart")}</span>
                                </th>
                            </tr>
                        </thead>
                        <tbody>
                            {data.periods.map((period) => (
                                <PeriodRow
                                    key={period.key}
                                    name={periodName(period.key)}
                                    period={period}
                                    currency={currency}
                                    money={money}
                                    peak={peak}
                                    t={t}
                                />
                            ))}
                            <tr className="border-t border-border font-semibold">
                                <th scope="row" className="sticky left-0 bg-card px-3 py-2 text-left">
                                    {t("forecast.total")}
                                </th>
                                <td className="px-3 py-2 text-right tabular-nums">{due}</td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    {money(total.won)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    {money(total.open)}
                                </td>
                                <td className="px-3 py-2 text-right tabular-nums">
                                    {money(total.expected)}
                                </td>
                                <td />
                            </tr>
                            {extra.map((period) => (
                                <PeriodRow
                                    key={period.key}
                                    name={periodName(period.key)}
                                    period={period}
                                    currency={currency}
                                    money={money}
                                    peak={0}
                                    t={t}
                                    muted
                                />
                            ))}
                        </tbody>
                    </table>
                </div>
                <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.75rem] text-muted-foreground">
                    <span className="flex items-center gap-1.5">
                        <span
                            aria-hidden
                            className="size-2.5 rounded-sm"
                            style={{ background: "var(--crm-series-3)" }}
                        />
                        {t("forecast.won")}
                    </span>
                    <span className="flex items-center gap-1.5">
                        <span
                            aria-hidden
                            className="size-2.5 rounded-sm"
                            style={{ background: "var(--crm-series-1)" }}
                        />
                        {t("forecast.weighted")}
                    </span>
                </p>
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
                <h1 className="mr-auto text-[1.0625rem] font-semibold leading-tight tracking-tight">
                    {t("forecast.title")}
                </h1>
                <SegmentedControl
                    size="sm"
                    aria-label={t("forecast.granularity")}
                    value={choice.granularity}
                    onValueChange={(granularity) => setChoice({ granularity })}
                    options={model.FORECAST_GRANULARITIES.map((value) => ({
                        value,
                        label: t(`forecast.${value}`)
                    }))}
                />
                <Select
                    aria-label={t("forecast.span")}
                    value={String(choice.periods)}
                    onValueChange={(value) => setChoice({ periods: Number(value) })}
                    options={SPANS.map((count) => ({
                        value: String(count),
                        label: t("forecast.next", { count })
                    }))}
                />
                <SegmentedControl
                    size="sm"
                    aria-label={t("forecast.whose")}
                    value={choice.mine ? "mine" : "all"}
                    onValueChange={(value) => setChoice({ mine: value === "mine" })}
                    options={[
                        { value: "all", label: t("forecast.everyone") },
                        { value: "mine", label: t("forecast.mine") }
                    ]}
                />
                {currencies.length > 1 ? (
                    <Select
                        aria-label={t("forecast.currency")}
                        value={currency}
                        onValueChange={setCurrencyPick}
                        options={currencies.map((code) => ({ value: code, label: code }))}
                    />
                ) : null}
                <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditingOdds(true)}
                    disabled={!data}
                >
                    <Percent className="size-3.5" />
                    {t("forecast.odds")}
                </Button>
                <Button asChild variant="ghost" size="sm">
                    <Link href="/crm/opportunities">
                        <Target className="size-3.5" />
                        {t("forecast.openList")}
                    </Link>
                </Button>
            </div>
            {body}
            {mounted ? <StageFlowPanel mine={choice.mine} /> : null}
            {editingOdds && data ? (
                <OddsDialog
                    odds={data.odds}
                    canEdit={Boolean(reading.data?.canEditOdds)}
                    onSaved={() => reading.refresh()}
                    onClose={() => setEditingOdds(false)}
                />
            ) : null}
        </div>
    );
}

type Translator = ReturnType<typeof useCrmT>;

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
    return (
        <div className="min-w-0 rounded-lg border border-border bg-card p-4" title={hint}>
            <p className="truncate text-[0.75rem] text-muted-foreground">{label}</p>
            <p className="truncate text-[1.5rem] font-semibold tabular-nums" title={value}>
                {value}
            </p>
            {hint ? <p className="mt-1 text-[0.75rem] text-muted-foreground">{hint}</p> : null}
        </div>
    );
}

function PeriodRow({
    name,
    period,
    currency,
    money,
    peak,
    t,
    muted = false
}: {
    name: string;
    period: model.ForecastPeriod;
    currency: string;
    money: (value: number) => string;
    peak: number;
    t: Translator;
    muted?: boolean;
}) {
    const amounts = period.money[currency] ?? { won: 0, open: 0, expected: 0 };
    const share = (value: number) => (peak === 0 ? 0 : (value / peak) * 100);
    return (
        <tr
            className={cn("border-b border-border last:border-0", muted && "text-muted-foreground")}
        >
            <th scope="row" className="sticky left-0 whitespace-nowrap bg-card px-3 py-2 text-left font-normal">
                {name}
            </th>
            <td className="px-3 py-2 text-right tabular-nums">
                {period.deals}
                {period.wonDeals > 0 ? (
                    <span className="ml-1 text-muted-foreground">
                        ({t("forecast.wonCount", { count: period.wonDeals })})
                    </span>
                ) : null}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{money(amounts.won)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{money(amounts.open)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{money(amounts.expected)}</td>
            <td className="px-3 py-2">
                {peak > 0 ? (
                    <span
                        aria-hidden
                        className="flex h-3 w-full overflow-hidden rounded-[4px]"
                        title={`${money(amounts.won)} / ${money(amounts.expected)}`}
                    >
                        <span
                            className="h-full"
                            style={{
                                width: `${share(amounts.won)}%`,
                                background: "var(--crm-series-3)"
                            }}
                        />
                        <span
                            className="h-full"
                            style={{
                                width: `${share(amounts.expected - amounts.won)}%`,
                                background: "var(--crm-series-1)"
                            }}
                        />
                    </span>
                ) : null}
            </td>
        </tr>
    );
}

function OddsDialog({
    odds,
    canEdit,
    onSaved,
    onClose
}: {
    odds: model.Odds;
    canEdit: boolean;
    onSaved: () => void;
    onClose: () => void;
}) {
    const t = useCrmT();
    const toast = useToast();
    const stageField = fieldOf("opportunities", "stage")!;
    const [draft, setDraft] = useState<Record<model.OpenStage, string>>(
        () =>
            Object.fromEntries(
                model.OPEN_STAGES.map((stage) => [stage, String(odds[stage])])
            ) as Record<model.OpenStage, string>
    );
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const parsed = Object.fromEntries(
        model.OPEN_STAGES.map((stage) => {
            const text = draft[stage].trim();
            return [stage, /^\d{1,3}$/.test(text) ? Number(text) : Number.NaN];
        })
    ) as Record<model.OpenStage, number>;
    const wrong = (stage: model.OpenStage) =>
        !Number.isInteger(parsed[stage]) || parsed[stage] < 0 || parsed[stage] > 100;
    const valid = model.OPEN_STAGES.every((stage) => !wrong(stage));
    const changed = model.OPEN_STAGES.some((stage) => parsed[stage] !== odds[stage]);

    const save = () => {
        if (!canEdit || !valid || !changed || busy) return;
        setBusy(true);
        setError(null);
        unwrap(() => actions.saveOddsAction(parsed), t("errors.generic"))
            .then(() => {
                toast.show({ title: t("forecast.oddsSaved") });
                onSaved();
                onClose();
            })
            .catch((caught) => setError(messageOf(caught)))
            .finally(() => setBusy(false));
    };

    return (
        <Dialog open onOpenChange={(open) => !open && onClose()}>
            <DialogContent className="sm:max-w-sm">
                <DialogHeader>
                    <DialogTitle>{t("forecast.oddsTitle")}</DialogTitle>
                </DialogHeader>
                <p className="text-[0.8125rem] text-muted-foreground">
                    {canEdit ? t("forecast.oddsBody") : t("forecast.oddsReadOnly")}
                </p>
                <div className="flex flex-col gap-2">
                    {model.OPEN_STAGES.map((stage) => (
                        <label
                            key={stage}
                            className="grid grid-cols-[minmax(0,1fr)_6rem] items-center gap-3 text-[0.8125rem]"
                        >
                            <span className="truncate">
                                {optionLabel(t, "opportunities", stageField, stage)}
                            </span>
                            <span className="flex items-center gap-1">
                                <Input
                                    inputMode="numeric"
                                    value={draft[stage]}
                                    disabled={!canEdit || busy}
                                    aria-invalid={wrong(stage) || undefined}
                                    onChange={(event) => {
                                        setDraft({ ...draft, [stage]: event.target.value });
                                        setError(null);
                                    }}
                                    onKeyDown={(event) => {
                                        if (event.key === "Enter") save();
                                    }}
                                />
                                %
                            </span>
                        </label>
                    ))}
                    <p className="text-[0.75rem] text-muted-foreground">
                        {t("forecast.wonAlways", {
                            stage: optionLabel(t, "opportunities", stageField, model.WON_STAGE)
                        })}
                    </p>
                </div>
                {!valid || error ? (
                    <p className="text-[0.75rem] text-danger">
                        {!valid ? t("forecast.oddsInvalid") : error}
                    </p>
                ) : null}
                <DialogFooter>
                    <Button variant="ghost" onClick={onClose}>
                        {canEdit ? t("dashboards.dialog.cancel") : t("forecast.close")}
                    </Button>
                    {canEdit ? (
                        <Button onClick={save} disabled={!valid || !changed || busy}>
                            {t("forecast.save")}
                        </Button>
                    ) : null}
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
