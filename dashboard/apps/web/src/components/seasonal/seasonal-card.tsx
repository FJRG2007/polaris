"use client";

/**
 * The account's seasonal switches, on Preferences: the decoration and the
 * season's sounds, each saved the moment it moves and put back if the save is
 * refused. Says which season is on, or which comes next and when, so a switch
 * flipped in June is not a switch that seems to do nothing.
 *
 * With the deployment's switch off, both are shown off and cannot be moved, and
 * the card says who turned them off.
 */

import { Play } from "lucide-react";
import * as core from "@polaris/core";
import { playCallSound } from "@/lib/call-sounds";
import { useEffect, useId, useState, useTransition } from "react";
import { playChimeOf } from "@/lib/notification-sound";
import { useDisplayFormat } from "@/components/display-format";
import { SEASON_ICONS } from "./seasonal-frame";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Button, Card, CardBody, CardHeader, CardTitle, Switch } from "@polaris/ui";
import { saveSeasonalAction } from "@/app/(app)/account/preferences/seasonal-actions";

export function SeasonalCard({
    allowed,
    initial
}: {
    allowed: boolean;
    initial: core.SeasonalChoice;
}) {
    const t = useTranslations("account");
    const format = useDisplayFormat();
    const offId = useId();
    const [choice, setChoice] = useState(initial);
    const [error, setError] = useState("");
    const [, startSaving] = useTransition();
    // The reader's date, taken once the page is in the browser: the server has
    // no idea what day it is where they are, and a guess would be redrawn.
    const [now, setNow] = useState<Date | null>(null);
    useEffect(() => setNow(new Date()), []);
    const today = now ? core.seasonOn(now) : null;

    function change(field: keyof core.SeasonalChoice, next: boolean) {
        const before = choice;
        setChoice({ ...choice, [field]: next });
        setError("");
        startSaving(async () => {
            const result = await saveSeasonalAction({ [field]: next }).catch(() => ({
                error: t("seasonal.notSaved"),
                choice: undefined
            }));
            if (result.error) {
                setError(result.error);
                setChoice(before);
            }
        });
    }

    const lastDay = now && today ? core.seasonLastDay(now) : null;
    const next = now && !today ? core.nextSeason(now) : null;
    // Nothing to announce on a deployment that has seasons off: the card says
    // that instead.
    const shown = allowed ? (today ?? next?.season ?? null) : null;
    const Icon = shown ? SEASON_ICONS[shown] : null;

    function preview() {
        if (!shown) return;
        playChimeOf(shown);
        // The ring after the chime has finished, as it would arrive.
        window.setTimeout(() => playCallSound("ring", shown), 600);
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("seasonal.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <p className="text-sm text-muted-foreground">{t("seasonal.intro")}</p>
                {/* The line is held open before the date is known, so nothing below
                    it moves when it fills in. */}
                <p className="flex min-h-5 min-w-0 items-center gap-2 text-sm">
                    {Icon && shown ? (
                        <>
                            <Icon
                                aria-hidden="true"
                                className="size-4 shrink-0 text-muted-foreground"
                            />
                            <span className="min-w-0">
                                {today && lastDay
                                    ? t("seasonal.onUntil", {
                                          season: t(`seasonal.names.${today}`),
                                          date: format.date(lastDay)
                                      })
                                    : next
                                      ? t("seasonal.nextFrom", {
                                            season: t(`seasonal.names.${next.season}`),
                                            date: format.date(next.from)
                                        })
                                      : null}
                            </span>
                        </>
                    ) : null}
                </p>
                {allowed ? null : (
                    <p id={offId} className="text-sm text-muted-foreground">
                        {t("seasonal.offForAll")}
                    </p>
                )}
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("seasonal.theme")}</p>
                        <p className="text-xs text-muted-foreground">{t("seasonal.themeHint")}</p>
                    </div>
                    <Switch
                        checked={allowed && choice.theme}
                        disabled={!allowed}
                        onChange={(next) => change("theme", next)}
                        aria-label={t("seasonal.theme")}
                        aria-describedby={allowed ? undefined : offId}
                    />
                </div>
                <div className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-sm font-medium">{t("seasonal.sounds")}</p>
                        <p className="text-xs text-muted-foreground">{t("seasonal.soundsHint")}</p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        {shown && allowed ? (
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={preview}
                                aria-label={t("seasonal.preview", {
                                    season: t(`seasonal.names.${shown}`)
                                })}
                                title={t("seasonal.preview", {
                                    season: t(`seasonal.names.${shown}`)
                                })}
                            >
                                <Play aria-hidden="true" className="size-3.5" />
                            </Button>
                        ) : null}
                        <Switch
                            checked={allowed && choice.sounds}
                            disabled={!allowed}
                            onChange={(next) => change("sounds", next)}
                            aria-label={t("seasonal.sounds")}
                            aria-describedby={allowed ? undefined : offId}
                        />
                    </div>
                </div>
                {error ? (
                    <p role="alert" className="text-xs text-danger">
                        {error}
                    </p>
                ) : null}
            </CardBody>
        </Card>
    );
}
