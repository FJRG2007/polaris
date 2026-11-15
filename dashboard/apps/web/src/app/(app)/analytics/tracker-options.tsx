"use client";

/**
 * The tracker's switches set for the site here, so the tag needs only its key.
 * Each switch saves on its own, shown at once and put back if the save fails.
 * An attribute on the tag still wins for the script's own switches; the two
 * privacy ones are applied by Polaris whatever the tag says.
 */

import type { AnalyticsScope } from "./site-catalog";
import { useEffect, useState, useTransition } from "react";
import { useTranslations } from "@/components/i18n/i18n-provider";
import { Card, CardBody, CardHeader, CardTitle, Skeleton, Switch } from "@polaris/ui";
import { getTrackerOptionsAction, setTrackerOptionsAction } from "./actions";
import type { TrackerOptions } from "@/lib/analytics-tracker-options";

const SWITCHES = ["outbound", "downloads", "forms", "hash", "vitals", "excludeSearch", "doNotTrack"] as const;

export function TrackerOptionsCard({ scope, siteId, canEdit }: { scope: AnalyticsScope; siteId: string; canEdit: boolean }) {
    const t = useTranslations("analytics");
    const [options, setOptions] = useState<TrackerOptions | null>(null);
    const [failure, setFailure] = useState<string | null>(null);
    const [pending, startTransition] = useTransition();

    useEffect(() => {
        let live = true;
        setOptions(null);
        setFailure(null);
        void getTrackerOptionsAction({ scopeType: scope, scopeId: siteId }).then((result) => {
            if (!live) return;
            if (result.error || !result.options) setFailure(result.error ?? null);
            else setOptions(result.options);
        });
        return () => {
            live = false;
        };
    }, [scope, siteId]);

    const toggle = (name: (typeof SWITCHES)[number], checked: boolean) => {
        if (!options || options[name] === checked) return;
        const before = options;
        const next = { ...options, [name]: checked };
        setOptions(next);
        setFailure(null);
        startTransition(async () => {
            const result = await setTrackerOptionsAction({ scopeType: scope, scopeId: siteId, options: next });
            if (result.error) {
                setOptions(before);
                setFailure(result.error);
            }
        });
    };

    return (
        <Card>
            <CardHeader>
                <CardTitle className="text-sm">{t("trackerOptions.title")}</CardTitle>
            </CardHeader>
            <CardBody className="flex flex-col gap-3 pt-0">
                <p className="text-sm text-muted-foreground">{t("trackerOptions.intro")}</p>
                {!options ? (
                    failure ? (
                        <p className="text-sm text-destructive">{failure}</p>
                    ) : (
                        <Skeleton className="h-32 w-full" />
                    )
                ) : (
                    <>
                        <div className="grid gap-3 sm:grid-cols-2">
                            {SWITCHES.map((name) => (
                                <label key={name} className="flex min-w-0 items-start gap-2 text-sm">
                                    <Switch
                                        checked={options[name]}
                                        disabled={!canEdit || pending}
                                        aria-label={t(`trackerOptions.${name}`)}
                                        onChange={(checked) => toggle(name, checked)}
                                    />
                                    <span className="flex min-w-0 flex-col">
                                        <span className="font-medium">{t(`trackerOptions.${name}`)}</span>
                                        <span className="text-xs text-muted-foreground">{t(`trackerOptions.${name}Hint`)}</span>
                                    </span>
                                </label>
                            ))}
                        </div>
                        {failure && <p className="text-sm text-destructive">{failure}</p>}
                    </>
                )}
            </CardBody>
        </Card>
    );
}
