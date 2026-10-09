"use client";

/**
 * The season's sound pack, on Preferences: one switch, named after the pack in
 * force, that turns it off for this account until the season ends - the way
 * Discord offers its Halloween sound pack. Saved the moment it moves and put
 * back if the save is refused.
 *
 * There is nothing else to choose: Polaris runs the packs on their dates, and
 * the decoration follows the operator's switch alone. Outside a season, or with
 * that switch off, there is no pack to turn off and the card is not drawn.
 */

import { Play } from "lucide-react";
import * as core from "@polaris/core";
import { playCallSound } from "@/lib/call-sounds";
import { useEffect, useState, useTransition } from "react";
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
    const [choice, setChoice] = useState(initial);
    const [error, setError] = useState("");
    const [, startSaving] = useTransition();
    // The reader's date, taken once the page is in the browser: the server has
    // no idea what day it is where they are, and a guess would be redrawn.
    const [now, setNow] = useState<Date | null>(null);
    useEffect(() => setNow(new Date()), []);

    const season = now ? core.seasonOn(now) : null;
    const pack = now ? core.packOn(now) : null;
    const lastDay = now ? core.packLastDay(now) : null;
    if (!allowed || !season || !pack || !lastDay) return null;

    const name = t(`seasonal.names.${core.packOf(season)}`);
    const Icon = SEASON_ICONS[season];
    const on = choice.mutedPack !== pack;

    function change(next: boolean) {
        const before = choice;
        const mutedPack = next ? null : pack;
        setChoice({ mutedPack });
        setError("");
        startSaving(async () => {
            const result = await saveSeasonalAction({ mutedPack }).catch(() => ({
                error: t("seasonal.notSaved"),
                choice: undefined
            }));
            if (result.error) {
                setError(result.error);
                setChoice(before);
            }
        });
    }

    function preview() {
        if (!season) return;
        playChimeOf(season);
        // The ring after the chime has finished, as it would arrive.
        window.setTimeout(() => playCallSound("ring", season), 600);
    }

    return (
        <Card>
            <CardHeader>
                <CardTitle>{t("seasonal.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-4">
                <div className="flex items-center justify-between gap-3">
                    <div className="flex min-w-0 items-start gap-2">
                        <Icon
                            aria-hidden="true"
                            className="mt-0.5 size-4 shrink-0 text-muted-foreground"
                        />
                        <div className="min-w-0">
                            <p className="text-sm font-medium">
                                {t("seasonal.pack", { season: name })}
                            </p>
                            <p className="text-xs text-muted-foreground">
                                {t("seasonal.packHint", { date: format.date(lastDay) })}
                            </p>
                        </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                        <Button
                            size="sm"
                            variant="ghost"
                            onClick={preview}
                            aria-label={t("seasonal.preview", { season: name })}
                            title={t("seasonal.preview", { season: name })}
                        >
                            <Play aria-hidden="true" className="size-3.5" />
                        </Button>
                        <Switch
                            checked={on}
                            onChange={change}
                            aria-label={t("seasonal.pack", { season: name })}
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
