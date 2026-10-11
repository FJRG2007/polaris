"use client";

/**
 * The server's seasonal decorations on the Settings tab: one switch, and a line
 * saying what is showing now and why.
 *
 * The switch flips at once and goes back if the save fails. The last reading
 * paints first on a revisit; until the server's own answer arrives it cannot be
 * changed, so a flip is only ever made from what the server holds.
 */

import { useGameText } from "../game-text";
import { hostUi } from "@polaris/app-host/client";
import { Card, CardBody, Skeleton, Switch } from "@polaris/ui";
import { useEffect, useRef, useState, useTransition } from "react";
import type { SeasonalView } from "../../lib/minecraft/seasonal-service";
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

    function flip(on: boolean) {
        if (!view) return;
        const before = view;
        setError(null);
        setView({ ...view, on });
        startTransition(async () => {
            const result = await saveSeasonalAction({ installedAppId, on });
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
                            onChange={flip}
                            aria-label={t("seasonal.turnOn")}
                        />
                    ) : error ? null : (
                        <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
                    )}
                </div>
                {status && <p className="text-xs text-muted-foreground">{status}</p>}
                {error && <p className="text-xs text-destructive">{error}</p>}
            </CardBody>
        </Card>
    );
}
