"use client";

/**
 * The display defaults, read after the page has painted.
 *
 * The header is drawn by the server; the two cards below it come from the API,
 * painted from the last reading this tab kept when there is one, so a revisit
 * shows the form at once and the request only corrects what moved.
 */

import { ThemePolicyCard } from "./theme-policy";
import { useEffect, useRef, useState } from "react";
import { savePlatformDisplayAction } from "./actions";
import { Button, Card, CardBody, Skeleton } from "@polaris/ui";
import { useLiveResource } from "@/components/use-live-resource";
import { useTranslations } from "@/components/i18n/i18n-provider";
import type { DisplayAdminReading } from "@/app/api/admin/display/route";
import { DisplayPreferencesForm } from "@/components/display-preferences-form";
import { resolveDisplayPreferences, type UserDisplayPreferences } from "@polaris/core";

export const DISPLAY_ADMIN_URL = "/api/admin/display";
export const DISPLAY_ADMIN_CACHE_KEY = "admin.display";

/** The shape of the two cards, while there is nothing to draw them from. */
export function DisplayAdminSkeleton() {
    return (
        <div aria-busy="true" data-testid="display-admin-skeleton" className="flex flex-col">
            <Card>
                <CardBody className="flex flex-col gap-4">
                    {[0, 1, 2, 3, 4, 5].map((row) => (
                        <div key={row} className="flex flex-col gap-1.5">
                            <Skeleton className="h-4 w-32" />
                            <Skeleton className="h-9 w-full" />
                        </div>
                    ))}
                    <Skeleton className="h-9 w-24 self-end" />
                </CardBody>
            </Card>
            <Card className="mt-4">
                <CardBody className="flex items-start justify-between gap-4">
                    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                        <Skeleton className="h-4 w-56" />
                        <Skeleton className="h-3 w-full" />
                    </div>
                    <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
                </CardBody>
            </Card>
        </div>
    );
}

export function DisplayAdminPanel() {
    const t = useTranslations("admin");
    const live = useLiveResource<DisplayAdminReading>({
        url: DISPLAY_ADMIN_URL,
        cacheKey: DISPLAY_ADMIN_CACHE_KEY,
        intervalMs: 0,
        select: (body) => body as DisplayAdminReading
    });
    const reading = live.data;
    // The form holds its own draft, seeded once. A reading that arrives over a
    // different kept one starts it again from the newer values; one this screen
    // wrote itself does not, so a save does not throw away its own "saved" line.
    const written = useRef<DisplayAdminReading | null>(null);
    const [generation, setGeneration] = useState(0);
    useEffect(() => {
        if (reading && reading !== written.current) setGeneration((value) => value + 1);
    }, [reading]);

    if (!reading) {
        if (live.error === null) return <DisplayAdminSkeleton />;
        return (
            <Card>
                <CardBody className="flex flex-col items-start gap-3">
                    <p role="alert" className="text-sm text-danger">
                        {t("display.loadFailed")}
                    </p>
                    <Button size="sm" variant="secondary" onClick={live.refresh}>
                        {t("display.retry")}
                    </Button>
                </CardBody>
            </Card>
        );
    }

    const keep = (next: DisplayAdminReading) => {
        written.current = next;
        live.replace(next);
    };
    const platform = resolveDisplayPreferences(reading.platform);

    return (
        <>
            <DisplayPreferencesForm
                key={generation}
                initial={platform}
                fallback={platform}
                allowInherit={false}
                save={async (values: UserDisplayPreferences) => {
                    const result = await savePlatformDisplayAction(values);
                    if (!result.error) keep({ ...reading, platform: values });
                    return result;
                }}
            />
            <ThemePolicyCard
                key={`theme-${generation}`}
                allowed={reading.mayChooseTheme}
                onChanged={(allowed) => keep({ ...reading, mayChooseTheme: allowed })}
            />
        </>
    );
}
