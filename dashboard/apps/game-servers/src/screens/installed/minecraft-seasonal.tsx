"use client";

/**
 * The server's seasonal decorations on the Settings tab: one switch, a line
 * saying what is showing now and why, and how many seasonal mobs come out.
 *
 * Every change shows at once and goes back if the save fails. The last reading
 * paints first on a revisit; until the server's own answer arrives it cannot be
 * changed, so a flip is only ever made from what the server holds.
 */

import { useGameText } from "../game-text";
import { hostUi } from "@polaris/app-host/client";
import { Card, CardBody, Select, Skeleton, Switch } from "@polaris/ui";
import * as seasonal from "../../lib/minecraft/seasonal";
import { figureLanguage, formatPlain } from "../../lib/figures";
import { useEffect, useRef, useState, useTransition } from "react";
import type { SeasonalPatch, SeasonalView } from "../../lib/minecraft/seasonal-service";
import { readSeasonalAction, saveSeasonalAction } from "./seasonal-actions";

const { writeSnapshot } = hostUi.snapshotCache;
const { useKeptSnapshot } = hostUi.liveRead;

/** How old a kept reading may be and still paint first on a revisit. */
const KEPT_SEASONAL_MS = 24 * 3_600_000;

export function MinecraftSeasonal({
    installedAppId,
    canManage
}: {
    installedAppId: string;
    canManage: boolean;
}) {
    const t = useGameText("minecraft");
    const language = figureLanguage(hostUi.i18nProvider.useLocale());
    const times = (count: number) =>
        t("seasonal.times", { count: formatPlain(count, language, 2) });
    const [view, setView] = useState<SeasonalView | null>(null);
    const [heard, setHeard] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();
    const answered = useRef(false);
    const viewKey = `seasonal-view:${installedAppId}`;

    useKeptSnapshot<SeasonalView>(viewKey, KEPT_SEASONAL_MS, (kept) => {
        if (!answered.current) setView(kept.value);
    });
    useEffect(() => {
        if (heard && view) writeSnapshot(viewKey, view);
    }, [heard, viewKey, view]);
    useEffect(() => {
        void readSeasonalAction(installedAppId).then((answer) => {
            if (answered.current) return;
            if (!answer.view) {
                setError(answer.error ?? null);
                return;
            }
            answered.current = true;
            setHeard(true);
            setView(answer.view);
        });
    }, [installedAppId]);

    function save(patch: SeasonalPatch) {
        if (!view) return;
        const before = view;
        setError(null);
        setView({ ...view, ...patch });
        startTransition(async () => {
            const result = await saveSeasonalAction({ installedAppId, ...patch });
            answered.current = true;
            if (result.view) setView(result.view);
            else {
                setView(before);
                setError(result.error ?? t("seasonal.notSaved"));
            }
        });
    }

    const status = !view
        ? null
        : view.blocked
          ? t("seasonal.blocked")
          : !view.on
            ? t("seasonal.offHere")
            : view.unavailable
              ? t("seasonal.unavailable")
              : view.needsRestart
                ? t("seasonal.needsRestart")
                : view.paused && view.season
                  ? t("seasonal.paused")
                  : view.showing === "halloween"
                    ? t("seasonal.showingHalloween")
                    : view.showing === "winter"
                      ? t("seasonal.showingWinter")
                      : t("seasonal.waiting");

    return (
        <Card>
            <CardBody className="flex flex-col gap-2">
                <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("seasonal.title")}</p>
                        <p className="text-xs text-muted-foreground">{t("seasonal.hint")}</p>
                    </div>
                    {view ? (
                        <Switch
                            checked={view.on}
                            disabled={!canManage || !heard || pending || view.blocked}
                            onChange={(on) => save({ on })}
                            aria-label={t("seasonal.turnOn")}
                        />
                    ) : error ? null : (
                        <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
                    )}
                </div>
                {status && <p className="text-xs text-muted-foreground">{status}</p>}
                {view && view.on && !view.blocked && (
                    <div className="grid gap-3 sm:grid-cols-2">
                        <MobChoice
                            id={`${installedAppId}-night-spawns`}
                            label={t("seasonal.nightSpawns")}
                            hint={t("seasonal.nightSpawnsHint")}
                            value={view.nightSpawns}
                            choices={seasonal.NIGHT_SPAWN_CHOICES}
                            none={t("seasonal.asUsual")}
                            times={times}
                            disabled={!canManage || !heard || pending}
                            onChange={(nightSpawns) => save({ nightSpawns })}
                        />
                        <MobChoice
                            id={`${installedAppId}-snow-golems`}
                            label={t("seasonal.snowGolems")}
                            hint={t("seasonal.snowGolemsHint")}
                            value={view.snowGolems}
                            choices={seasonal.SNOW_GOLEM_CHOICES}
                            none={t("seasonal.none")}
                            times={times}
                            disabled={!canManage || !heard || pending}
                            onChange={(snowGolems) => save({ snowGolems })}
                        />
                    </div>
                )}
                {view?.on && view.mobsNeedRestart && (
                    <p className="text-xs text-muted-foreground">{t("seasonal.mobsNeedRestart")}</p>
                )}
                {error && <p className="text-xs text-destructive">{error}</p>}
            </CardBody>
        </Card>
    );
}

/** One seasonal mob setting: a multiple of the usual, the first choice being none. */
function MobChoice({
    id,
    label,
    hint,
    value,
    choices,
    none,
    times,
    disabled,
    onChange
}: {
    id: string;
    label: string;
    hint: string;
    value: number;
    choices: readonly number[];
    none: string;
    times: (count: number) => string;
    disabled: boolean;
    onChange: (value: number) => void;
}) {
    return (
        <div className="flex min-w-0 flex-col gap-1">
            <label htmlFor={id} className="text-xs font-medium">
                {label}
            </label>
            <Select
                id={id}
                value={String(value)}
                onValueChange={(next) => {
                    const picked = Number(next);
                    if (picked !== value && choices.includes(picked)) onChange(picked);
                }}
                options={choices.map((choice, index) => ({
                    value: String(choice),
                    label: index === 0 ? none : times(choice)
                }))}
                disabled={disabled}
            />
            <p className="text-xs text-muted-foreground">{hint}</p>
        </div>
    );
}
