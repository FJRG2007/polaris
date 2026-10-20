"use client";

/**
 * The settings of "A reading crosses a threshold": what to watch (a server, a
 * service, a UPS), which reading, the comparison and value, how many samples
 * in a row, and whether the way back starts a run too. Each field is judged
 * live by the schema save and publish use (`thresholdFieldStates`).
 */

import * as core from "@polaris/core";
import { useEffect, useState } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Input, Select, Switch, type SelectOption } from "@polaris/ui";
import { thresholdChoicesAction, type ThresholdKindChoice } from "../actions";
import {
    numberFromInput,
    sourceKey,
    thresholdFieldStates,
    type FieldState
} from "@/lib/automations/threshold-form";

type Config = Record<string, any>;

/** What a source reads as, in the reader's words; one nothing names yet reads as its id. */
export function useSourceLabel(): (source: string) => string {
    const t = useTranslations("automations");
    return (source) => {
        const key = sourceKey(source);
        return t.has(key) ? t(key as "threshold.sources.host_cpu") : source;
    };
}

function Labeled({
    label,
    state,
    invalid,
    children
}: {
    label: string;
    state: FieldState;
    invalid: string;
    children: React.ReactNode;
}) {
    return (
        <label className="block min-w-0 space-y-1 text-sm">
            <span>{state === "ok" ? label : `${label} *`}</span>
            {children}
            {state === "invalid" ? (
                <span className="block text-xs text-danger-ink">{invalid}</span>
            ) : null}
        </label>
    );
}

export function ThresholdFields({
    config,
    set,
    setConfig
}: {
    config: Config;
    set: (change: Config) => void;
    setConfig: (config: Config) => void;
}) {
    const t = useTranslations("automations");
    const label = useSourceLabel();
    const [kinds, setKinds] = useState<readonly ThresholdKindChoice[] | null>(null);
    const [error, setError] = useState("");
    const [valueText, setValueText] = useState(
        typeof config.value === "number" ? String(config.value) : ""
    );
    const [streakText, setStreakText] = useState(
        typeof config.streak === "number" ? String(config.streak) : "3"
    );
    useEffect(() => {
        let cancelled = false;
        void thresholdChoicesAction().then((answer) => {
            if (cancelled) return;
            if (answer.ok) setKinds(answer.kinds);
            else setError(answer.error);
        });
        return () => {
            cancelled = true;
        };
    }, []);

    const source = typeof config.source === "string" ? config.source : "";
    const kindId = source.includes(".") ? source.slice(0, source.indexOf(".")) : "";
    const kind = kinds?.find((entry) => entry.kind === kindId) ?? null;
    const states = thresholdFieldStates(config);
    const subjectId = typeof config.subjectId === "string" ? config.subjectId : "";
    const subjectGone =
        kind !== null && subjectId !== "" && !kind.subjects.some((one) => one.id === subjectId);
    const unit = kind?.sources.find((entry) => entry.id === source)?.unit ?? "";
    const streak = typeof config.streak === "number" ? config.streak : 3;

    const kindOptions: SelectOption[] = (kinds ?? []).map((entry) => ({
        value: entry.kind,
        label: t.has(`threshold.kinds.${entry.kind}`)
            ? t(`threshold.kinds.${entry.kind}` as "threshold.kinds.host")
            : entry.kind
    }));
    const subjectOptions: SelectOption[] = (kind?.subjects ?? []).map((one) => ({
        value: one.id,
        label: one.name
    }));
    const sourceOptions: SelectOption[] = (kind?.sources ?? []).map((one) => ({
        value: one.id,
        label: label(one.id)
    }));
    const comparatorOptions: SelectOption[] = core.THRESHOLD_COMPARATORS.map((value) => ({
        value,
        label: t(`threshold.comparators.${value}`)
    }));

    return (
        <div className="space-y-3">
            <p className="text-xs text-muted-foreground">{t("nodeHints.threshold")}</p>
            {error ? <p className="text-xs text-danger-ink">{error}</p> : null}
            <div className="grid gap-3 sm:grid-cols-2">
                <Labeled label={t("threshold.watch")} state={kindId ? "ok" : "required"} invalid="">
                    <Select
                        value={kindId}
                        placeholder={t(kinds === null ? "threshold.loading" : "threshold.pick")}
                        options={kindOptions}
                        onValueChange={(next) => {
                            const chosen = kinds?.find((entry) => entry.kind === next);
                            if (!chosen || next === kindId) return;
                            setConfig({
                                ...config,
                                source: chosen.sources[0]?.id ?? "",
                                subjectId: ""
                            });
                        }}
                        aria-label={t("threshold.watch")}
                    />
                </Labeled>
                <Labeled
                    label={t("threshold.subject")}
                    state={states.subjectId}
                    invalid={t("threshold.subjectPick")}
                >
                    <Select
                        value={subjectGone ? "" : subjectId}
                        placeholder={t(kinds === null ? "threshold.loading" : "threshold.pick")}
                        options={subjectOptions}
                        disabled={!kind}
                        onValueChange={(next) => set({ subjectId: next })}
                        aria-label={t("threshold.subject")}
                    />
                </Labeled>
            </div>
            {kind && kind.subjects.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t("threshold.subjectNone")}</p>
            ) : null}
            {subjectGone ? (
                <p className="text-xs text-danger-ink">{t("threshold.subjectGone")}</p>
            ) : null}
            <Labeled
                label={t("threshold.reading")}
                state={kind ? states.source : "ok"}
                invalid={t("threshold.invalidSource")}
            >
                <Select
                    value={sourceOptions.some((option) => option.value === source) ? source : ""}
                    placeholder={t("threshold.pick")}
                    options={sourceOptions}
                    disabled={!kind}
                    onValueChange={(next) => set({ source: next })}
                    aria-label={t("threshold.reading")}
                />
            </Labeled>
            <div className="grid gap-3 sm:grid-cols-2">
                <Labeled label={t("threshold.comparison")} state={states.comparator} invalid="">
                    <Select
                        value={typeof config.comparator === "string" ? config.comparator : "gt"}
                        options={comparatorOptions}
                        onValueChange={(comparator) => set({ comparator })}
                        aria-label={t("threshold.comparison")}
                    />
                </Labeled>
                <Labeled
                    label={unit ? t("threshold.valueIn", { unit }) : t("threshold.value")}
                    state={states.value}
                    invalid={t("threshold.invalidValue")}
                >
                    <Input
                        inputMode="decimal"
                        value={valueText}
                        aria-invalid={states.value === "invalid" || undefined}
                        onChange={(event) => {
                            setValueText(event.target.value);
                            set({ value: numberFromInput(event.target.value) });
                        }}
                    />
                </Labeled>
            </div>
            <Labeled
                label={t("threshold.streak")}
                state={states.streak}
                invalid={t("threshold.invalidStreak")}
            >
                <Input
                    inputMode="numeric"
                    value={streakText}
                    aria-invalid={states.streak === "invalid" || undefined}
                    onChange={(event) => {
                        setStreakText(event.target.value);
                        set({ streak: numberFromInput(event.target.value) });
                    }}
                />
            </Labeled>
            {states.streak === "ok" ? (
                <p className="text-xs text-muted-foreground">
                    {t("threshold.streakHint", { minutes: streak })}
                </p>
            ) : null}
            <label className="flex items-center justify-between gap-2 text-sm">
                <span className="min-w-0">{t("threshold.recovery")}</span>
                <Switch
                    checked={config.recovery === true}
                    aria-label={t("threshold.recovery")}
                    onChange={(on: boolean) => set({ recovery: on })}
                />
            </label>
            <p className="text-xs text-muted-foreground">
                {t("threshold.readsHint", {
                    value: "{{trigger.value}}",
                    state: "{{trigger.state}}"
                })}
            </p>
        </div>
    );
}
