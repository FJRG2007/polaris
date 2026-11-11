"use client";

import type { ReactNode } from "react";
import { paintRead } from "@/app/(app)/admin/paint-read";
import { MovedRegion } from "@/app/(app)/admin/moved-region";
import { AfterPaint } from "@/components/after-paint";
import { AppServicesPanel, AppServicesSkeleton } from "./app-services-panel";

/**
 * An app's settings below the page's header: its own settings and the
 * services it runs - or, when the data says there are none here, a move to the
 * app's page.
 */
export function AppSettingsLoader({
    appId,
    own,
    revision
}: {
    appId: string;
    /** The app's own settings panel, drawn by the page when it has one. */
    own: ReactNode;
    revision: number;
}) {
    return (
        <AfterPaint
            cacheKey={`admin.app-settings:${appId}`}
            load={() => paintRead("apps.settings", { appId })}
            persist={false}
            revision={revision}
            skeleton={<AppServicesSkeleton />}
        >
            {(data) =>
                data.screen === "moved" ? (
                    <MovedRegion to={data.to}>
                        <AppServicesSkeleton />
                    </MovedRegion>
                ) : (
                    <>
                        {own}
                        {data.services ? (
                            <AppServicesPanel appId={appId} services={data.services} />
                        ) : null}
                    </>
                )
            }
        </AfterPaint>
    );
}
