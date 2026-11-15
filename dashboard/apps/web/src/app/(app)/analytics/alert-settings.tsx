"use client";

/**
 * The reader's own traffic alerts and summary for one site: a spike threshold,
 * a drop threshold and a weekly or monthly summary, all delivered to their
 * Polaris notifications. Empty means off. Saved only when something differs
 * from what was loaded.
 */

import type { AnalyticsScope } from "./site-catalog";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { useEffect, useMemo, useState, useTransition } from "react";
import { getAlertSettingsAction, setAlertSettingsAction } from "./actions";
import { Button, Card, CardBody, CardHeader, CardTitle, Input, Select, Skeleton } from "@polaris/ui";

type Digest = "off" | "weekly" | "monthly";
interface Draft {
    spike: string;
    drop: string;
    digest: Digest;
}

const MAX = 1_000_000;

/** A threshold field's value: null when empty, a number when valid, "invalid" otherwise. */
export function parseThreshold(text: string): number | null | "invalid" {
    const trimmed = text.trim().replace(/[\s,.]/g, "");
    if (!trimmed) return null;
    if (!/^\d+$/.test(trimmed)) return "invalid";
    const value = Number(trimmed);
    return value >= 1 && value <= MAX ? value : "invalid";
}

function draftOf(settings: { spikeVisitors: number | null; dropVisitors: number | null; digest: Digest }): Draft {
    return {
        spike: settings.spikeVisitors === null ? "" : String(settings.spikeVisitors),
        drop: settings.dropVisitors === null ? "" : String(settings.dropVisitors),
        digest: settings.digest
    };
}

export function AlertSettingsCard({ scope, siteId }: { scope: AnalyticsScope; siteId: string }) {
    const t = useTranslations("analytics");
    const [loaded, setLoaded] = useState<Draft | null>(null);
    const [draft, setDraft] = useState<Draft | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [saved, setSaved] = useState(false);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let live = true;
        setLoaded(null);
        setDraft(null);
        void getAlertSettingsAction({ scopeType: scope, scopeId: siteId }).then((result) => {
            if (!live) return;
            if (result.error || !result.settings) {
                setFailure(result.error ?? null);
                return;
            }
            const next = draftOf(result.settings);
            setLoaded(next);
            setDraft(next);
        });
        return () => {
            live = false;
        };
    }, [scope, siteId]);

    const spike = draft ? parseThreshold(draft.spike) : null;
    const drop = draft ? parseThreshold(draft.drop) : null;
    const invalid = spike === "invalid" || drop === "invalid";
    const dirty = useMemo(() => {
        if (!draft || !loaded) return false;
        return (
            parseThreshold(draft.spike) !== parseThreshold(loaded.spike) ||
            parseThreshold(draft.drop) !== parseThreshold(loaded.drop) ||
            draft.digest !== loaded.digest
        );
    }, [draft, loaded]);

    const save = () => {
        if (!draft || !loaded || invalid || !dirty) return;
        const before = loaded;
        // Shown as saved at once, put back if the save fails.
        setLoaded(draft);
        setFailure(null);
        startTransition(async () => {
            const result = await setAlertSettingsAction({
                scopeType: scope,
                scopeId: siteId,
                settings: { spikeVisitors: spike, dropVisitors: drop, digest: draft.digest }
            });
            if (result.error) {
                setLoaded(before);
                setFailure(result.error);
                return;
            }
            setSaved(true);
            window.setTimeout(() => setSaved(false), 2000);
        });
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{t("alerts.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 pt-0">
                <p className="text-sm text-muted-foreground">{t("alerts.intro")}</p>
                {!draft ? (
                    failure ? (
                        <p className="text-sm text-destructive">{failure}</p>
                    ) : (
                        <Skeleton className="h-24 w-full" />
                    )
                ) : (
                    <>
                        <div className="grid gap-3 sm:grid-cols-3">
                            <label className="flex min-w-0 flex-col gap-1 text-sm">
                                <span className="font-medium">{t("alerts.spike")}</span>
                                <Input
                                    inputMode="numeric"
                                    value={draft.spike}
                                    placeholder={t("alerts.off")}
                                    aria-invalid={spike === "invalid"}
                                    onChange={(event) => setDraft({ ...draft, spike: event.target.value })}
                                />
                                <span className="truncate text-xs text-muted-foreground" title={t("alerts.spikeHint")}>
                                    {t("alerts.spikeHint")}
                                </span>
                            </label>
                            <label className="flex min-w-0 flex-col gap-1 text-sm">
                                <span className="font-medium">{t("alerts.drop")}</span>
                                <Input
                                    inputMode="numeric"
                                    value={draft.drop}
                                    placeholder={t("alerts.off")}
                                    aria-invalid={drop === "invalid"}
                                    onChange={(event) => setDraft({ ...draft, drop: event.target.value })}
                                />
                                <span className="truncate text-xs text-muted-foreground" title={t("alerts.dropHint")}>
                                    {t("alerts.dropHint")}
                                </span>
                            </label>
                            <div className="flex min-w-0 flex-col gap-1 text-sm">
                                <span className="font-medium">{t("alerts.digest")}</span>
                                <Select
                                    value={draft.digest}
                                    aria-label={t("alerts.digest")}
                                    onValueChange={(value) => setDraft({ ...draft, digest: value as Digest })}
                                    options={[
                                        { value: "off", label: t("alerts.digestOff") },
                                        { value: "weekly", label: t("alerts.digestWeekly") },
                                        { value: "monthly", label: t("alerts.digestMonthly") }
                                    ]}
                                />
                            </div>
                        </div>
                        {invalid && <p className="text-sm text-destructive">{t("alerts.invalid")}</p>}
                        {failure && <p className="text-sm text-destructive">{failure}</p>}
                        <div className="flex items-center gap-2">
                            <Button size="sm" onClick={save} disabled={!dirty || invalid || pending}>
                                {t("alerts.save")}
                            </Button>
                            {saved && <span className="text-xs text-muted-foreground">{t("alerts.saved")}</span>}
                        </div>
                    </>
                )}
            </CardBody>
        </Card>
    );
}
