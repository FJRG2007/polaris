"use client";

/**
 * The deployment's seasonal themes: the switch for all of them, and every
 * season the calendar in @polaris/core defines - its window, its own switch,
 * dates an admin can move and put back, and a preview for this session alone.
 *
 * The switches save the moment they move and are put back if the save is
 * refused. Dates are checked as they are picked, against the same schema and
 * the same overlap rule the server applies, and saved with a button.
 */

import * as core from "@polaris/core";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState, useTransition } from "react";
import { SEASON_ICONS, usePreviewSeason } from "@/components/seasonal/seasonal-frame";
import { useLocale, useTranslations } from "@/components/i18n/i18n-provider";
import { Badge, Button, Card, CardBody, CardHeader, CardTitle, Select, Switch } from "@polaris/ui";
import {
    previewSeasonAction,
    saveSeasonRuleAction,
    setSeasonsAllowedAction
} from "./seasonal-actions";
import { stopSeasonPreviewAction } from "@/app/(app)/account/preferences/seasonal-actions";

export function SeasonalAdminCard({
    initial,
    calendar: initialCalendar,
    preview: initialPreview
}: {
    initial: boolean;
    calendar: core.SeasonCalendar;
    preview: core.Season | null;
}) {
    const t = useTranslations("admin");
    const nav = useTranslations("nav");
    const router = useRouter();
    const [allowed, setAllowed] = useState(initial);
    const [calendar, setCalendar] = useState(initialCalendar);
    const [preview, setPreview] = useState(initialPreview);
    // The frame is redrawn from the server whenever a preview starts or stops,
    // here or from its own bar, so it is the answer this card follows; the copy
    // above only covers the moment between a click and that redraw.
    const framed = usePreviewSeason();
    useEffect(() => {
        if (framed !== undefined) setPreview(framed);
    }, [framed]);
    const [error, setError] = useState("");
    const [, startSaving] = useTransition();

    function toggle(next: boolean) {
        setAllowed(next);
        setError("");
        startSaving(async () => {
            const result = await setSeasonsAllowedAction(next).catch(() => ({
                error: t("settings.seasonal.notSaved")
            }));
            if (result.error) {
                setError(result.error);
                setAllowed(!next);
            }
        });
    }

    /** Preview a season, or stop with null. The page is drawn again from the
     *  server so the frame, the sounds and the bar all follow. */
    function previewOf(season: core.Season | null): Promise<string | null> {
        const before = preview;
        setPreview(season);
        return (season ? previewSeasonAction(season) : stopSeasonPreviewAction())
            .catch(() => ({
                error: season
                    ? t("settings.seasonal.previewFailed")
                    : nav("seasonPreview.notStopped")
            }))
            .then((result) => {
                if (result.error) {
                    setPreview(before);
                    return result.error;
                }
                router.refresh();
                return null;
            });
    }

    return (
        <Card className="mt-4">
            <CardHeader>
                <CardTitle>{t("settings.seasonal.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3">
                <p className="text-sm text-muted-foreground">{t("settings.seasonal.body")}</p>
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("settings.seasonal.label")}</p>
                        <p className="text-xs text-muted-foreground">
                            {allowed ? t("settings.seasonal.on") : t("settings.seasonal.off")}
                        </p>
                    </div>
                    <Switch
                        checked={allowed}
                        onChange={toggle}
                        aria-label={t("settings.seasonal.label")}
                    />
                </div>
                {error ? (
                    <p role="alert" className="text-xs text-danger">
                        {error}
                    </p>
                ) : null}
                <div className="mt-2 border-t border-border pt-4">
                    <p className="text-sm font-medium">{t("settings.seasonal.calendarTitle")}</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                        {t("settings.seasonal.calendarBody")}
                    </p>
                    <ul className="mt-3 flex flex-col divide-y divide-border">
                        {core.SEASONS.map((season) => (
                            <SeasonRow
                                key={season}
                                season={season}
                                calendar={calendar}
                                onSaved={setCalendar}
                                previewing={preview === season}
                                onPreview={(on) => previewOf(on ? season : null)}
                            />
                        ))}
                    </ul>
                </div>
            </CardBody>
        </Card>
    );
}

type End = "from" | "to";

/** A day of the year as the reader writes it: "7 Oct", or a lunar month and day. */
function useDayLabel(): (season: core.Season, day: core.MonthDay) => string {
    const locale = useLocale();
    const t = useTranslations("admin");
    return useMemo(() => {
        const solar = new Intl.DateTimeFormat(locale, {
            day: "numeric",
            month: "short",
            timeZone: "UTC"
        });
        return (season, { month, day }) =>
            core.SEASON_KINDS[season] === "lunar"
                ? t("settings.seasonal.lunarDay", { month, day })
                : // A leap year, so 29 February is a day it can name.
                  solar.format(new Date(Date.UTC(2024, month - 1, day)));
    }, [locale, t]);
}

function SeasonRow({
    season,
    calendar,
    onSaved,
    previewing,
    onPreview
}: {
    season: core.Season;
    calendar: core.SeasonCalendar;
    onSaved: (calendar: core.SeasonCalendar) => void;
    previewing: boolean;
    onPreview: (on: boolean) => Promise<string | null>;
}) {
    const t = useTranslations("admin");
    const names = useTranslations("nav");
    const locale = useLocale();
    const dayLabel = useDayLabel();
    const saved = calendar[season];
    const [draft, setDraft] = useState<core.SeasonWindow>(saved.window);
    const [enabled, setEnabled] = useState(saved.enabled);
    const [error, setError] = useState<{ text: string; field?: End } | null>(null);
    const [saving, startSaving] = useTransition();
    const [previewBusy, startPreview] = useTransition();

    const name = names(`season.${season}`);
    const Icon = SEASON_ICONS[season];
    const lunar = core.SEASON_KINDS[season] === "lunar";
    const shipped = core.DEFAULT_SEASON_CALENDAR[season].window;

    // Checked as it is picked: the same schema and overlap rule the server runs.
    const check = useMemo(() => {
        const parsed = core.seasonRuleSchema(season).safeParse({ enabled, ...draft });
        if (!parsed.success) {
            const field = parsed.error.issues[0]?.path[0] === "to" ? "to" : "from";
            return { text: t("settings.seasonal.dayOutOfMonth"), field } as const;
        }
        const clash = core.seasonOverlaps(
            { ...calendar, [season]: { enabled, window: draft } },
            season
        )[0];
        return clash
            ? ({
                  text: t("settings.seasonal.overlaps", { season: names(`season.${clash}`) })
              } as const)
            : null;
    }, [season, enabled, draft, calendar, t, names]);

    const sameWindow = (a: core.SeasonWindow, b: core.SeasonWindow) =>
        a.from.month === b.from.month &&
        a.from.day === b.from.day &&
        a.to.month === b.to.month &&
        a.to.day === b.to.day;
    const dirty = !sameWindow(draft, saved.window);
    const atDefault = sameWindow(draft, shipped);
    const shown = check ?? error;

    const months = useMemo(() => {
        const monthName = new Intl.DateTimeFormat(locale, { month: "long", timeZone: "UTC" });
        return Array.from({ length: 12 }, (_, index) => ({
            value: String(index + 1),
            label: lunar
                ? t("settings.seasonal.lunarMonth", { month: index + 1 })
                : monthName.format(new Date(Date.UTC(2024, index, 1)))
        }));
    }, [locale, lunar, t]);

    function save(rule: { enabled: boolean; window: core.SeasonWindow }, rollback: () => void) {
        setError(null);
        startSaving(async () => {
            const result = await saveSeasonRuleAction(season, {
                enabled: rule.enabled,
                ...rule.window
            }).catch(() => ({ error: t("settings.seasonal.notSaved") }) as const);
            if (result.error !== undefined) {
                setError({
                    text: result.error,
                    field: "field" in result ? result.field : undefined
                });
                rollback();
                return;
            }
            onSaved(result.calendar);
        });
    }

    function toggle(next: boolean) {
        setEnabled(next);
        // The dates saved, not the ones being picked: the switch is its own change.
        save({ enabled: next, window: saved.window }, () => setEnabled(!next));
    }

    function pick(end: End, part: "month" | "day", value: string) {
        setError(null);
        setDraft((was) => ({ ...was, [end]: { ...was[end], [part]: Number(value) } }));
    }

    function reset() {
        const before = draft;
        setDraft(shipped);
        save({ enabled: saved.enabled, window: shipped }, () => setDraft(before));
    }

    function preview() {
        startPreview(async () => {
            const failed = await onPreview(!previewing);
            setError(failed ? { text: failed } : null);
        });
    }

    const endPicker = (end: End) => {
        const label = t(`settings.seasonal.${end}`);
        const days = core.daysInSeasonMonth(season, draft[end].month);
        const invalid = shown?.field === end;
        return (
            <div className="flex min-w-0 flex-col gap-1">
                <span className="text-xs text-muted-foreground">{label}</span>
                <div className="flex min-w-0 gap-2" aria-invalid={invalid || undefined}>
                    <Select
                        value={String(draft[end].month)}
                        onValueChange={(value) => pick(end, "month", value)}
                        options={months}
                        aria-label={`${label}: ${t("settings.seasonal.month")}`}
                        className={`w-36 min-w-0 ${invalid ? "border-danger" : ""}`}
                    />
                    <Select
                        value={String(draft[end].day)}
                        onValueChange={(value) => pick(end, "day", value)}
                        options={Array.from({ length: Math.max(days, draft[end].day) }, (_, i) => ({
                            value: String(i + 1),
                            label: String(i + 1)
                        }))}
                        aria-label={`${label}: ${t("settings.seasonal.day")}`}
                        className={`w-20 min-w-0 ${invalid ? "border-danger" : ""}`}
                    />
                </div>
            </div>
        );
    };

    return (
        <li className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0">
            <div className="flex items-start justify-between gap-3">
                <div className="flex min-w-0 items-start gap-2.5">
                    <Icon
                        aria-hidden="true"
                        className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                    />
                    <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-medium" title={name}>
                                {name}
                            </p>
                            {!lunar && core.crossesYearEnd(saved.window) ? (
                                <Badge>{t("settings.seasonal.crossesYear")}</Badge>
                            ) : null}
                            {!core.isDefaultWindow(season, saved.window) ? (
                                <Badge variant="warning">{t("settings.seasonal.custom")}</Badge>
                            ) : null}
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t("settings.seasonal.window", {
                                from: dayLabel(season, saved.window.from),
                                to: dayLabel(season, saved.window.to)
                            })}
                            {" - "}
                            {enabled
                                ? t("settings.seasonal.seasonOn")
                                : t("settings.seasonal.seasonOff")}
                        </p>
                    </div>
                </div>
                <Switch
                    checked={enabled}
                    onChange={toggle}
                    disabled={saving}
                    aria-label={`${name}: ${t("settings.seasonal.seasonOn")}`}
                />
            </div>
            <div className="flex flex-wrap items-end gap-3">
                {endPicker("from")}
                {endPicker("to")}
            </div>
            {shown ? (
                <p role="alert" className="text-xs text-danger">
                    {shown.text}
                </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-2">
                <Button
                    size="sm"
                    onClick={() => save({ enabled, window: draft }, () => undefined)}
                    disabled={!dirty || check !== null || saving}
                >
                    {t("settings.seasonal.save")}
                </Button>
                <Button
                    size="sm"
                    variant="outline"
                    onClick={reset}
                    disabled={atDefault || saving}
                    title={t("settings.seasonal.defaultWindow", {
                        window: t("settings.seasonal.window", {
                            from: dayLabel(season, shipped.from),
                            to: dayLabel(season, shipped.to)
                        })
                    })}
                >
                    {t("settings.seasonal.reset")}
                </Button>
                <Button
                    size="sm"
                    variant={previewing ? "secondary" : "ghost"}
                    onClick={preview}
                    disabled={previewBusy}
                    title={t("settings.seasonal.previewHint")}
                >
                    {previewing
                        ? t("settings.seasonal.stopPreview")
                        : t("settings.seasonal.preview")}
                </Button>
            </div>
        </li>
    );
}
